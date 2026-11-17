// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp, JSON-RPC 2.0).
// Plain JSON answers (no SSE). The tools/list array is built once at startup so two
// calls are byte-identical.

import {
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './core.ts';
import { issueGlobalId, pullGlobalId, repoGlobalId } from './core.ts';
import { isConflicted, mergePullRequest, repoJson } from './rest.ts';

export const SERVER_INFO = { name: 'gitforge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

export interface McpResult {
  status: number;
  json: unknown;
  /** When true, the body is empty (202 for notifications). */
  empty?: boolean;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}
function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}
function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function issuePayload(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.seq + 100000,
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullPayload(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.seq + 100000,
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function callTool(store: Store, baseUrl: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (tool: ToolDef): string | null => {
    for (const req of tool.inputSchema.required) {
      if (args[req] === undefined || args[req] === null || args[req] === '') return `Missing required argument: ${req}`;
    }
    return null;
  };
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  const miss = missing(tool);
  if (miss) return toolError(miss);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError('name already exists on this account');
      const repo = store.createRepo(VIEWER_LOGIN, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolResult({ ...repoJson(repo, baseUrl), node_id: repoGlobalId(repo) });
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      return toolResult({ ...repoJson(repo, baseUrl), node_id: repoGlobalId(repo) });
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const issue: Issue = {
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: store.nextId(),
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return toolResult(issuePayload(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      const payload = items.map((i) => issuePayload(repo, i));
      return toolResult({ issues: payload });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch does not exist');
      const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing) return toolResult(pullPayload(repo, existing));
      const pull: Pull = {
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        seq: store.nextId(),
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return toolResult(pullPayload(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolError(`Repository not found: ${args.owner}/${args.repo}`);
      const num = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return toolError(`Pull request not found: ${num}`);
      if (pull.merged) return toolResult({ merged: true, sha: pull.mergeCommitSha, number: pull.number });
      if (isConflicted(repo, pull)) return toolError('Merge conflict');
      const sha = mergePullRequest(repo, pull);
      if (sha === null) return toolError('Merge conflict');
      return toolResult({ merged: true, sha, number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/** Handle one POST /mcp request. `rawBody` is the exact request text. */
export function handleMcp(store: Store, baseUrl: string, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Non-JSON body: HTTP 400, JSON-RPC -32700, id extracted from the raw text when present.
    let id: unknown = null;
    const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(rawBody);
    if (match) {
      try {
        id = JSON.parse(match[1]);
      } catch {
        id = null;
      }
    }
    return rpcError(id, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are answered 202 with an empty body.
  if (method.startsWith('notifications/')) {
    return { status: 202, json: null, empty: true };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = LEGACY_VERSIONS.has(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // Byte-identical across calls: the prebuilt JSON string is parsed fresh each time
      // (same bytes in, same object out).
      return rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as unknown);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === toolName)) {
        return rpcError(id, -32601, `Method not found: ${toolName}`);
      }
      const result = callTool(store, baseUrl, toolName, args);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
