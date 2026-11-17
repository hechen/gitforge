// core.ts — the forge's store, git object model, pack read/write, reachability and
// tree utilities. Node stdlib only (node:crypto, node:zlib). Everything response-visible
// is deterministic: fixed timestamps, sequential ids, insertion-ordered maps.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_TS = 1700000000;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// Commits and trees
// ---------------------------------------------------------------------------

export function commitData(treeOid: string, parents: readonly string[], message: string): Buffer {
  const lines: string[] = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_TS} +0000`);
  lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_TS} +0000`);
  lines.push('');
  lines.push(message);
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  oid: string;
}

/** Git tree sort: directory names compare as if they ended with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function treeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(off, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message: message.replace(/\n$/, '') };
}

export function parseTag(data: Buffer): { object: string; type: ObjType } {
  const text = data.toString('utf8');
  let object = '';
  let type: ObjType = 'commit';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line === '') break;
  }
  return { object, type };
}

// ---------------------------------------------------------------------------
// Pack files (version 2, plain objects + OFS/REF deltas)
// ---------------------------------------------------------------------------

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2) from objects; entries sorted by oid for determinism. */
export function writePack(objects: ReadonlyArray<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of sorted) {
    parts.push(encodePackEntryHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

/** Inflate the zlib stream starting at `off`, expecting `expectedSize` bytes out.
 *  Returns the data and how many input bytes the stream consumed (found by binary
 *  search: inflateSync ignores trailing bytes and succeeds exactly at stream end). */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  const hi = Math.min(buf.length, off + expectedSize + 1024 + (expectedSize >> 6) + 16);
  let lo = off;
  let high = hi;
  // Invariant: inflateSync(buf[off..high]) succeeds with the expected size.
  // First verify the upper bound succeeds.
  let probe: Buffer;
  try {
    probe = inflateSync(buf.subarray(off, high));
  } catch {
    throw new Error('pack entry is not valid zlib data');
  }
  if (probe.length !== expectedSize) throw new Error('pack entry inflated to the wrong size');
  while (lo + 1 < high) {
    const mid = (lo + high) >> 1;
    try {
      const out = inflateSync(buf.subarray(off, mid));
      if (out.length === expectedSize) high = mid;
      else lo = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(off, high)), consumed: high - off };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const baseSize = readVarint(delta, off);
  off = baseSize.next;
  const resultSize = readVarint(delta, off);
  off = resultSize.next;
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

export interface ReadPackOptions {
  /** Resolve a REF-delta base that is not in this pack (thin packs). */
  resolveBase?: (oid: string) => GitObject | undefined;
}

/** Read a pack into a map of oid -> object, resolving deltas. */
export function readPack(buf: Buffer, options: ReadPackOptions = {}): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack file');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // First pass: read raw entries, remembering offsets for OFS-delta bases.
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer; // inflated payload (for deltas: the delta instructions)
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let byte = buf[off];
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS-delta: negative offset varint.
      let b = buf[off];
      off += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateAt(buf, off, size);
    off += inflated.consumed;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: inflated.data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  // Second pass: resolve, with memoisation (deltas may chain).
  const resolved = new Map<number, GitObject>();
  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    let obj: GitObject;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      obj = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    } else if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (baseEntry) base = resolve(baseEntry, depth + 1);
      } else if (entry.baseOid) {
        for (const e of entries) {
          // A REF-delta base inside this pack: find the entry whose oid matches.
          // Oids are only known after resolving, so resolve plain entries eagerly.
          if (e.typeCode >= 1 && e.typeCode <= 4) {
            const candidate = resolve(e, depth + 1);
            if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
              base = candidate;
              break;
            }
          }
        }
        if (!base && options.resolveBase) base = options.resolveBase(entry.baseOid);
      }
      if (!base) throw new Error('delta base not found');
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      throw new Error(`unknown pack entry type ${entry.typeCode}`);
    }
    resolved.set(entry.offset, obj);
    return obj;
  };
  for (const entry of entries) {
    const obj = resolve(entry, 0);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextObjectId = 1;
  reqSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      seq: this.repos.size,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  nextId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }
}

/** Store one object in a repo, returning its oid. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Resolve a ref-ish (branch name, full ref, or oid) to an oid, or undefined. */
export function resolveRef(repo: Repo, refish: string): string | undefined {
  if (repo.refs.has(refish)) return repo.refs.get(refish);
  const asHead = repo.refs.get(`refs/heads/${refish}`);
  if (asHead) return asHead;
  if (/^[0-9a-f]{40}$/.test(refish) && repo.objects.has(refish)) return refish;
  return undefined;
}

/** True when `ancestor` is reachable from `descendant` (following parents; tags
 *  followed to target). Stops as soon as the ancestor is found. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** The commits reachable from `tips` (following parents; tags followed to target). */
export function reachableCommits(repo: Repo, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      stack.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    out.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

function collectTree(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') collectTree(repo, e.oid, into);
    else into.add(e.oid);
  }
}

/**
 * Objects to send for a fetch of `wants`, excluding anything reachable from `haves`.
 * Depth: want = generation 1; commits at exactly `depth` are the shallow boundary.
 * `knownShallow`: boundaries the client already has; ones now fully included are unshallow.
 */
export function fetchSelection(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  knownShallow: readonly string[],
): { objects: Array<{ oid: string; type: ObjType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  // BFS generations from the wants.
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; g: number }> = [];
  const include = new Set<string>();
  const shallow = new Set<string>();
  const push = (oid: string, g: number): void => {
    const prev = gen.get(oid);
    if (prev !== undefined && prev <= g) return;
    gen.set(oid, g);
    queue.push({ oid, g });
  };
  for (const w of wants) push(w, 1);
  while (queue.length) {
    const { oid, g } = queue.shift() as { oid: string; g: number };
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      include.add(oid);
      push(parseTag(obj.data).object, g);
      continue;
    }
    if (obj.type !== 'commit') {
      include.add(oid);
      continue;
    }
    if (depth !== undefined && g > depth) continue;
    include.add(oid);
    const { parents } = parseCommit(obj.data);
    if (depth !== undefined && g === depth) {
      shallow.add(oid);
      continue;
    }
    for (const p of parents) push(p, g + 1);
  }
  const unshallow: string[] = [];
  if (depth === undefined) {
    for (const s of knownShallow) if (gen.has(s)) unshallow.push(s);
  } else {
    for (const s of knownShallow) {
      const g = gen.get(s);
      if (g !== undefined && g < depth) unshallow.push(s);
    }
  }
  // Objects: included commits + their tree closures + included tags.
  const objectIds = new Set<string>();
  for (const oid of include) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objectIds.add(oid);
    if (obj.type === 'commit') collectTree(repo, parseCommit(obj.data).tree, objectIds);
  }
  // Subtract what the client already holds. A have's history is excluded, but the walk
  // stops at the client's shallow boundaries: it holds those commits, not their parents,
  // so a deepen must still deliver the parents.
  const boundaries = new Set(knownShallow);
  const haveCommits = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (haveCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    haveCommits.add(oid);
    if (boundaries.has(oid)) continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const excluded = new Set<string>();
  for (const c of haveCommits) {
    const obj = repo.objects.get(c);
    if (!obj) continue;
    excluded.add(c);
    collectTree(repo, parseCommit(obj.data).tree, excluded);
  }
  const out: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  for (const oid of objectIds) {
    if (excluded.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) out.push({ oid, type: obj.type, data: obj.data });
  }
  return { objects: out, shallow: [...shallow], unshallow };
}

/** Flatten a tree to path -> {oid, mode} for file entries only. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

/** Build trees bottom-up from a flat file map; returns the root tree oid. */
export function buildTreeFromFlat(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Array<{ name: string; oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, v] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], oid: v.oid, mode: v.mode });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const f of node.files) entries.push({ mode: f.mode, name: f.name, oid: f.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', treeData(entries));
  };
  return build(root);
}

/** Diff two flattened trees. */
export function diffTrees(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> {
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', baseOid: b.oid, headOid: null });
    else if (!b && h) out.push({ path, status: 'added', baseOid: null, headOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', baseOid: b.oid, headOid: h.oid });
  }
  return out;
}

/** Line counts for a diff: additions/deletions between two blob contents. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS on lines (files here are small).
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

/** Global ids: opaque, stable, never the plain database id. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
export function unb64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}
export function repoGlobalId(repo: Repo): string {
  return b64url(`R:${repo.id}`);
}
export function issueGlobalId(repo: Repo, number: number): string {
  return b64url(`I:${repo.id}:${number}`);
}
export function pullGlobalId(repo: Repo, number: number): string {
  return b64url(`P:${repo.id}:${number}`);
}
export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return b64url(`C:${repo.id}:${issueNumber}:${commentId}`);
}
