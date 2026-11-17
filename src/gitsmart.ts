// gitsmart.ts — git smart HTTP: info/refs advertisements, upload-pack (v0 + v2),
// receive-pack. All framing is pkt-line; packs come from core.ts.

import {
  VIEWER_LOGIN,
  ZERO_OID,
  fetchSelection,
  isAncestor,
  parseTag,
  readPack,
  writePack,
  type Repo,
  type Store,
} from './core.ts';

export const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
export const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
export const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** One pkt-line frame for a string payload (payload must already end with '\n' when a line). */
export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktLineBuf(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Returns packets plus the byte offset where the
 *  pkt-line stream ended (the rest is raw pack data, or -1 when the whole buffer was
 *  valid pkt-lines). Parsing stops at the first malformed length, which is how the raw
 *  pack after a receive-pack flush is found (its 'PACK' header is not a hex length). */
export function decodePktLines(buf: Buffer): { packets: Packet[]; restOffset: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      return { packets, restOffset: off };
    }
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, restOffset: off < buf.length ? off : -1 };
}

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow agent=gitforge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=gitforge/1.0 symref=HEAD:refs/heads/main';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function refTargetOid(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** Peel a ref to its commit (following tag objects). Returns the commit oid. */
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** v0 advertisement body for a service. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const head = headRef(repo);
  const headOid = repo.refs.get(head);
  if (headOid === undefined && repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLineOid = headOid ?? ZERO_OID;
    parts.push(pktLine(`${headLineOid} HEAD\0${caps}\n`));
    for (const ref of sortedRefNames(repo)) {
      const oid = repo.refs.get(ref) as string;
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(repo, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement (upload-pack only; receive-pack is v0-only). */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=gitforge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

/** The ref lines a v2 ls-refs answer carries, already filtered by prefix. */
function lsRefsLines(
  repo: Repo,
  prefixes: readonly string[],
  peel: boolean,
  symrefs: boolean,
  unborn: boolean,
): string[] {
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const head = headRef(repo);
  const headOid = repo.refs.get(head);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${head}`;
      lines.push(line);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${head}`);
    }
  }
  for (const ref of sortedRefNames(repo)) {
    if (!keep(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (symrefs && ref === head) line += ` symref-target:${head}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    lines.push(line);
  }
  return lines;
}

function sidebandPack(pack: Buffer): Buffer {
  // One sideband packet per chunk of pack data. A pkt-line is at most 65520 bytes
  // including its 4-byte length, so a band-1 payload (1 band byte + data) is at most
  // 65516 bytes, i.e. at most 65515 bytes of pack data per packet.
  const chunks: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < pack.length; off += MAX) {
    const slice = pack.subarray(off, Math.min(pack.length, off + MAX));
    chunks.push(pktLineBuf(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) chunks.push(pktLineBuf(Buffer.from([1])));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseV2Command(packets: readonly Packet[]): { command: string; args: string[] } | null {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= / object-format= ignored
    } else {
      args.push(line);
    }
  }
  return command ? { command, args } : null;
}

/** Handle POST /<owner>/<repo>.git/git-upload-pack. Returns {status, contentType, body}. */
export function handleUploadPack(repo: Repo, body: Buffer, gitProtocolV2: boolean): { status: number; contentType: string; body: Buffer } {
  const { packets, restOffset } = decodePktLines(body);
  if (packets.length === 0) return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  const first = packets[0].payload.toString('utf8').replace(/\n$/, '');
  if (first !== 'version 2' && !first.startsWith('want ') && !first.startsWith('command=')) {
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  if (gitProtocolV2 || first === 'version 2' || first.startsWith('command=')) {
    return handleUploadPackV2(repo, packets);
  }
  return handleUploadPackV0(repo, packets);
}

function handleUploadPackV2(repo: Repo, packets: readonly Packet[]): { status: number; contentType: string; body: Buffer } {
  const parsed = parseV2Command(packets);
  if (!parsed) return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  if (parsed.command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const arg of parsed.args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const lines = lsRefsLines(repo, prefixes, peel, symrefs, unborn);
    const parts: Buffer[] = lines.map((l) => pktLine(`${l}\n`));
    parts.push(FLUSH);
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
  }
  if (parsed.command === 'fetch') {
    const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
    for (const arg of parsed.args) {
      if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) req.depth = parseInt(arg.slice(7).trim(), 10);
      // thin-pack / no-progress / ofs-delta / done / filter: accepted, no effect
    }
    if (req.wants.some((w) => !isHex40(w))) {
      return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
    }
    return fetchResponse(repo, req, true);
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
}

function handleUploadPackV0(repo: Repo, packets: readonly Packet[]): { status: number; contentType: string; body: Buffer } {
  // Two sections: wants (+shallow/deepen) terminated by flush, then haves + done + flush.
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).split(' ');
        if (isHex40(rest[0])) req.wants.push(rest[0]);
      } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      // done: ignored
    }
  }
  if (req.wants.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  return fetchResponse(repo, req, false);
}

function fetchResponse(repo: Repo, req: FetchRequest, v2: boolean): { status: number; contentType: string; body: Buffer } {
  const { objects, shallow, unshallow } = fetchSelection(repo, req.wants, req.haves, req.depth, req.shallow);
  const pack = writePack(objects);
  const hasHaves = req.haves.length > 0;
  if (v2) {
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (hasHaves) {
      for (const h of req.haves) if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
      if (parts.length === 1) parts.push(pktLine('NAK\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(DELIM);
    if (shallow.length || unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(DELIM);
    }
    const wantedRefs: string[] = [];
    const head = headRef(repo);
    const headOid = repo.refs.get(head);
    if (headOid !== undefined && req.wants.includes(headOid)) wantedRefs.push(`${headOid} HEAD`);
    for (const ref of sortedRefNames(repo)) {
      const oid = repo.refs.get(ref) as string;
      if (req.wants.includes(oid)) wantedRefs.push(`${oid} ${ref}`);
    }
    parts.push(pktLine('wanted-refs\n'));
    for (const r of wantedRefs) parts.push(pktLine(`${r}\n`));
    parts.push(DELIM);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
  }
  // v0: NAK/ACK + shallow/unshallow lines, then sideband pack packets.
  const parts: Buffer[] = [];
  if (hasHaves) {
    let acked = false;
    for (const h of req.haves) {
      if (repo.objects.has(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

/** Handle POST /<owner>/<repo>.git/git-receive-pack. */
export function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const { packets, restOffset } = decodePktLines(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3 || !isHex40(parts[0]) || !isHex40(parts[1])) {
      return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  // Unpack the pack that follows the command list (delete-only carries none).
  const hasPack = commands.some((c) => c.newOid !== ZERO_OID);
  let incoming = new Map<string, { type: import('./core.ts').ObjType; data: Buffer }>();
  if (hasPack && restOffset >= 0 && restOffset < body.length) {
    try {
      incoming = readPack(body.subarray(restOffset), {
        resolveBase: (oid) => repo.objects.get(oid),
      });
    } catch {
      // Unpack failure: report it; no ref is applied.
      return pushReport([{ ref: commands[0].ref, ok: false, reason: 'unpack error' }], false);
    }
  }
  // Store every incoming object (hashes already verified by readPack).
  for (const [oid, obj] of incoming) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  // Validate each command; apply only the ok ones.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = true;
    let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (!repo.objects.has(cmd.newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else {
      // Update.
      if (current === undefined || cmd.oldOid !== current) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (cmd.newOid === current) {
        ok = true; // no-op update
      } else if (!repo.objects.has(cmd.newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      } else {
        const newObj = repo.objects.get(cmd.newOid) as { type: string; data: Buffer };
        if (newObj.type === 'tag') {
          // Tag updates to a different oid are refused.
          ok = false;
          reason = 'non-fast-forward';
        } else if (newObj.type !== 'commit') {
          ok = false;
          reason = 'non-fast-forward';
        } else {
          const reachable = isAncestor(repo, cmd.oldOid, cmd.newOid);
          if (!reachable) {
            ok = false;
            reason = 'non-fast-forward';
          }
        }
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
    }
    results.push({ ref: cmd.ref, ok, reason });
  }
  return pushReport(results, true);
}

function pushReport(
  results: Array<{ ref: string; ok: boolean; reason: string }>,
  unpackOk: boolean,
): { status: number; contentType: string; body: Buffer } {
  const inner: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const r of results) {
    inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const band1 = pktLineBuf(Buffer.concat([Buffer.from([1]), Buffer.concat(inner)]));
  return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat([band1, FLUSH]) };
}

export function gitRepoLookup(store: Store, owner: string, name: string): { repo: Repo } | { status: number } {
  if (owner !== VIEWER_LOGIN) return { status: 404 };
  const repo = store.getRepo(owner, name);
  if (!repo) return { status: 404 };
  return { repo };
}
