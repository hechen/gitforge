// app.ts — the forge's HTTP server: routing, auth, request ids, body reading.
// One process serves git smart HTTP, REST v3, GraphQL v4 and MCP from one Store.
//
// Auth: when MAKEFUN_SHOP_TOKEN is set, the Bearer token must match it exactly;
// otherwise any non-empty token is accepted. No token is always 401. /healthz takes
// no auth, and GET /api/v3/ is public, matching the starter's contract.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/core.ts';
import { handleRest, type RestResult } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import {
  RECEIVE_AD,
  RECEIVE_RESULT,
  UPLOAD_AD,
  UPLOAD_RESULT,
  gitRepoLookup,
  handleReceivePack,
  handleUploadPack,
  v0Advertisement,
  v2Advertisement,
} from './src/gitsmart.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function pathSegments(req: IncomingMessage): string[] {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** The bearer token on the request, or null when absent/malformed. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns {ok:false} on malformed JSON. */
function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${store.reqSeq + 1}`;
      store.reqSeq += 1;
      const commonHeaders: Record<string, string> = { 'x-github-request-id': requestId };
      const segments = pathSegments(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const baseUrl = baseUrlOf(req);

      const notFoundJson = (): void => sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
      const unauthorized = (): void => sendJson(res, 401, { message: 'Requires authentication' }, commonHeaders);

      // Boot probe: no auth.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true }, commonHeaders);
        return;
      }

      // API root is public.
      if (segments[0] === 'api' && segments[1] === 'v3' && segments.length === 2 && method === 'GET') {
        const result = handleRest({ store, method, segments: [], query, body: {}, baseUrl });
        if (result) {
          sendRest(res, result, commonHeaders);
          return;
        }
      }

      // Git smart HTTP: /<owner>/<repo>.git/...
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = segments[0];
        const repoName = segments[1].slice(0, -4);
        const tail = segments.slice(2);
        if (!authorized(req)) {
          unauthorized();
          return;
        }
        const lookup = gitRepoLookup(store, owner, repoName);
        if ('status' in lookup) {
          sendJson(res, lookup.status, { message: 'Not Found' }, commonHeaders);
          return;
        }
        const repo = lookup.repo;
        const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
          const service = query.get('service') ?? '';
          if (service === 'git-upload-pack') {
            if (wantsV2) sendRaw(res, 200, UPLOAD_AD, v2Advertisement(), commonHeaders);
            else sendRaw(res, 200, UPLOAD_AD, v0Advertisement(repo, 'git-upload-pack'), commonHeaders);
            return;
          }
          if (service === 'git-receive-pack') {
            sendRaw(res, 200, RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'), commonHeaders);
            return;
          }
          notFoundJson();
          return;
        }
        if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
          const body = await readBody(req);
          const result = handleUploadPack(repo, body, wantsV2);
          if (result.contentType === 'application/json') {
            sendJson(res, result.status, JSON.parse(result.body.toString('utf8')), commonHeaders);
          } else {
            sendRaw(res, result.status, result.contentType, result.body, commonHeaders);
          }
          return;
        }
        if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
          const body = await readBody(req);
          const result = handleReceivePack(repo, body);
          if (result.contentType === 'application/json') {
            sendJson(res, result.status, JSON.parse(result.body.toString('utf8')), commonHeaders);
          } else {
            sendRaw(res, result.status, result.contentType, result.body, commonHeaders);
          }
          return;
        }
        notFoundJson();
        return;
      }

      // Everything below needs auth.
      if (!authorized(req)) {
        unauthorized();
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : Buffer.alloc(0);
        const parsed = rawBody.length ? parseJsonBody(rawBody.toString('utf8')) : { ok: true as const, value: {} };
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, commonHeaders);
          return;
        }
        const result = handleRest({ store, method, segments: segments.slice(2), query, body: parsed.value, baseUrl });
        if (result === null) {
          notFoundJson();
          return;
        }
        sendRest(res, result, commonHeaders);
        return;
      }

      // GraphQL v4.
      if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
        if (method !== 'POST') {
          notFoundJson();
          return;
        }
        const rawBody = await readBody(req);
        const parsed = parseJsonBody(rawBody.toString('utf8'));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, commonHeaders);
          return;
        }
        const result = handleGraphQL({ store, baseUrl }, parsed.value);
        sendJson(res, 200, result, commonHeaders);
        return;
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method !== 'POST') {
          notFoundJson();
          return;
        }
        const rawBody = await readBody(req);
        const result = handleMcp(store, baseUrl, rawBody.toString('utf8'));
        if (result.empty) {
          res.writeHead(result.status, commonHeaders);
          res.end();
          return;
        }
        sendJson(res, result.status, result.json, commonHeaders);
        return;
      }

      notFoundJson();
    })().catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': `req-${store.reqSeq}` });
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
}

function sendRest(res: ServerResponse, result: RestResult, commonHeaders: Record<string, string>): void {
  const headers = { ...commonHeaders, ...(result.headers ?? {}) };
  if (result.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  sendJson(res, result.status, result.json, headers);
}
