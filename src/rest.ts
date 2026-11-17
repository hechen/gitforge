// rest.ts — GitHub REST v3: repos, branches, commits, contents, labels, issues,
// comments, pulls, merges. Pure functions over the Store; app.ts owns HTTP.

import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildTreeFromFlat,
  commitData,
  diffTrees,
  flattenTree,
  issueGlobalId,
  lineDiff,
  parseCommit,
  parseTree,
  pullGlobalId,
  putObject,
  repoGlobalId,
  resolveRef,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './core.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, json: unknown, headers?: Record<string, string>): RestResult => ({ status, json, headers });
const notFound = (message = 'Not Found'): RestResult => ok(404, { message });
const badRequest = (message: string): RestResult => ok(400, { message });
const unprocessable = (message: string): RestResult => ok(422, { message });

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`U:${VIEWER_LOGIN}`, 'utf8').toString('base64url'),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.seq + 100000,
    node_id: issueGlobalId(repo, issue.number),
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', default: false, description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  const headUser = userJson();
  const baseUser = userJson();
  return {
    id: pull.seq + 100000,
    node_id: pullGlobalId(repo, pull.number),
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: !isConflicted(repo, pull),
    mergeable_state: isConflicted(repo, pull) ? 'dirty' : 'clean',
    merged_by: pull.merged ? userJson() : null,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: headUser, repo: repoJson(repo, baseUrl) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: baseUser, repo: repoJson(repo, baseUrl) },
    author_association: 'OWNER',
    auto_merge: null,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const parsed = obj ? parseCommit(obj.data) : { tree: '', parents: [] as string[], message: '' };
  return {
    sha: oid,
    node_id: Buffer.from(`C:${oid}`, 'utf8').toString('base64url'),
    commit: {
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      message: parsed.message,
      tree: { sha: parsed.tree },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: userJson(),
    committer: userJson(),
    parents: parsed.parents.map((p) => ({ sha: p, url: '' })),
  };
}

function treeOidOfCommit(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

/** Paths changed between a PR's base commit and its head commit. */
function prDiff(repo: Repo, pull: Pull) {
  const baseFiles = flattenTree(repo, treeOidOfCommit(repo, pull.baseSha));
  const headFiles = flattenTree(repo, treeOidOfCommit(repo, pull.headSha));
  return diffTrees(baseFiles, headFiles);
}

/** True when merging this PR now would conflict with the current base tip. */
export function isConflicted(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return false;
  if (baseTip === pull.baseSha) return false;
  const baseFiles = flattenTree(repo, treeOidOfCommit(repo, pull.baseSha));
  const headFiles = flattenTree(repo, treeOidOfCommit(repo, pull.headSha));
  const curBaseFiles = flattenTree(repo, treeOidOfCommit(repo, baseTip));
  for (const d of diffTrees(baseFiles, headFiles)) {
    const baseOid = baseFiles.get(d.path)?.oid ?? null;
    const curOid = curBaseFiles.get(d.path)?.oid ?? null;
    if (curOid !== baseOid) {
      const headOid = headFiles.get(d.path)?.oid ?? null;
      if (headOid !== curOid) return true;
    }
  }
  return false;
}

function blobText(repo: Repo, oid: string | null): string {
  if (!oid) return '';
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

/** Squash-merge a pull request. Returns the merge commit oid, or null on conflict. */
export function mergePullRequest(repo: Repo, pull: Pull): string | null {
  if (pull.merged) return pull.mergeCommitSha;
  if (isConflicted(repo, pull)) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return null;
  const baseFiles = flattenTree(repo, treeOidOfCommit(repo, baseTip));
  const headFiles = flattenTree(repo, treeOidOfCommit(repo, headTip));
  const merged = new Map(baseFiles);
  for (const d of diffTrees(flattenTree(repo, treeOidOfCommit(repo, pull.baseSha)), headFiles)) {
    if (d.status === 'removed') merged.delete(d.path);
    else if (d.headOid) merged.set(d.path, { oid: d.headOid, mode: headFiles.get(d.path)?.mode ?? '100644' });
  }
  const treeOid = buildTreeFromFlat(repo, merged);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const commitOid = putObject(repo, 'commit', commitData(treeOid, [baseTip], message));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  return commitOid;
}

// ---------------------------------------------------------------------------
// Contents helpers
// ---------------------------------------------------------------------------

/** Ensure `branch` exists (creating it from the default tip when missing). */
function ensureBranch(repo: Repo, branch: string): string | undefined {
  const ref = `refs/heads/${branch}`;
  const existing = repo.refs.get(ref);
  if (existing) return existing;
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) {
    repo.refs.set(ref, defaultTip);
    return defaultTip;
  }
  return undefined; // unborn repo: the caller creates the first commit
}

function commitFileChange(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (files: Map<string, { oid: string; mode: string }>) => void,
): string {
  const tip = ensureBranch(repo, branch);
  const files = tip ? flattenTree(repo, treeOidOfCommit(repo, tip)) : new Map<string, { oid: string; mode: string }>();
  mutate(files);
  const treeOid = buildTreeFromFlat(repo, files);
  const parents = tip ? [tip] : [];
  const commitOid = putObject(repo, 'commit', commitData(treeOid, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

function listDirEntries(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      out.push({ type: 'dir', name: e.name, path, sha: e.oid, size: 0, url: '', git_url: '', html_url: '', download_url: null });
    } else {
      const blob = repo.objects.get(e.oid);
      out.push({ type: 'file', name: e.name, path, sha: e.oid, size: blob ? blob.data.length : 0, url: '', git_url: '', html_url: '', download_url: '' });
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const linkFor = (page: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `<${baseUrl}${path}?${q.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (pageNum < totalPages) links.push(linkFor(pageNum + 1, 'next'));
  if (pageNum > 1) links.push(linkFor(pageNum - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(totalPages, 'last'));
  return { page, headers: { link: links.join(', ') } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

/** Route one /api/v3 request. Returns null when the path is not an /api/v3 route. */
export function handleRest(ctx: RestContext): RestResult | null {
  const { store, method, segments, query, body, baseUrl } = ctx;
  const b = (body ?? {}) as Record<string, unknown>;

  // API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(200, { current_user_url: `${baseUrl}/api/v3/user`, rate_limit_url: `${baseUrl}/api/v3/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /meta
  if (segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // /user...
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound();
      return ok(200, userJson());
    }
    if (segments[1] === 'repos') {
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable('name is invalid');
        if (store.getRepo(VIEWER_LOGIN, name)) return unprocessable('name already exists on this account');
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          typeof b.description === 'string' ? b.description : '',
          b.private === true,
        );
        return ok(201, repoJson(repo, baseUrl));
      }
      if (method === 'GET') {
        const repos = store.listRepos(VIEWER_LOGIN);
        const { page, headers } = paginate(repos, query, baseUrl, '/api/v3/user/repos');
        return ok(200, page.map((r) => repoJson(r, baseUrl)), headers);
      }
      return notFound();
    }
    return notFound();
  }

  // /repos/{owner}/{repo}/...
  if (segments[0] === 'repos') {
    const owner = segments[1] ?? '';
    const name = segments[2] ?? '';
    if (!owner || !name) return notFound();
    if (owner !== VIEWER_LOGIN) return notFound();
    const rest = segments.slice(3);
    const repo = store.getRepo(owner, name);

    // POST /repos/{o}/{r} is not a route; repo create is via /user/repos.
    if (rest.length === 0) {
      if (!repo) return notFound();
      if (method === 'GET') return ok(200, repoJson(repo, baseUrl));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        return ok(200, repoJson(repo, baseUrl));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, json: null };
      }
      return notFound();
    }
    if (!repo) return notFound();

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return unprocessable('Invalid request');
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        if (!repo.objects.has(sha)) return unprocessable('Invalid SHA');
        repo.refs.set(ref, sha);
        return ok(201, { ref, node_id: Buffer.from(`R:${ref}`, 'utf8').toString('base64url'), object: { sha, type: 'commit', url: '' }, url: '' });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).join('/');
        const oid = repo.refs.get(ref);
        if (!oid) return notFound();
        return ok(200, { ref, node_id: Buffer.from(`R:${ref}`, 'utf8').toString('base64url'), object: { sha: oid, type: 'commit', url: '' }, url: '' });
      }
      return notFound();
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) as string, url: '' }, protected: false }));
        return ok(200, list);
      }
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) return notFound();
        return ok(200, { name: branch, commit: { sha: oid, url: '' }, protected: false });
      }
      return notFound();
    }

    // commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') return notFound();
      const shaParam = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, shaParam);
      if (!tip) return notFound();
      const out: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        out.push(commitJson(repo, oid));
        const parents = parseCommit(obj.data).parents;
        for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
      }
      const { page, headers } = paginate(out, query, baseUrl, `/api/v3/repos/${owner}/${name}/commits`);
      return ok(200, page, headers);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refParam = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = refParam ? resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return notFound();
        const files = flattenTree(repo, treeOidOfCommit(repo, tip));
        if (path === '') {
          return ok(200, listDirEntries(repo, treeOidOfCommit(repo, tip), ''));
        }
        const file = files.get(path);
        if (file) {
          const blob = repo.objects.get(file.oid);
          const data = blob ? blob.data : Buffer.alloc(0);
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: path.split('/').pop(),
            path,
            content: data.toString('base64'),
            sha: file.oid,
            url: '',
            git_url: '',
            html_url: '',
            download_url: '',
          });
        }
        // Directory?
        const prefix = `${path}/`;
        const isDir = [...files.keys()].some((p) => p.startsWith(prefix));
        if (isDir) {
          // Find the tree oid for this directory.
          let treeOid = treeOidOfCommit(repo, tip);
          const parts = path.split('/');
          let found = true;
          for (const part of parts) {
            const obj = repo.objects.get(treeOid);
            if (!obj || obj.type !== 'tree') {
              found = false;
              break;
            }
            const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
            if (!entry) {
              found = false;
              break;
            }
            treeOid = entry.oid;
          }
          if (!found) return notFound();
          return ok(200, listDirEntries(repo, treeOid, path));
        }
        return notFound();
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const tip = ensureBranch(repo, branch);
        const files = tip ? flattenTree(repo, treeOidOfCommit(repo, tip)) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(path);
        if (typeof b.sha === 'string' && b.sha !== '') {
          if (!existing || existing.oid !== (b.sha as string)) return ok(409, { message: 'sha does not match' });
        }
        const isCreate = !existing;
        const blobOid = putObject(repo, 'blob', data);
        const commitOid = commitFileChange(repo, branch, message, (f) => {
          f.set(path, { oid: blobOid, mode: '100644' });
        });
        return ok(isCreate ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, url: '', git_url: '', html_url: '', download_url: '', type: 'file', encoding: 'base64' },
          commit: { sha: commitOid, node_id: '', message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO } },
        });
      }
      if (method === 'DELETE') {
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return notFound();
        const files = flattenTree(repo, treeOidOfCommit(repo, tip));
        const existing = files.get(path);
        if (!existing) return notFound();
        if (typeof b.sha === 'string' && b.sha !== '' && existing.oid !== (b.sha as string)) return ok(409, { message: 'sha does not match' });
        const commitOid = commitFileChange(repo, branch, message, (f) => {
          f.delete(path);
        });
        return ok(200, { content: null, commit: { sha: commitOid, message } });
      }
      return notFound();
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        if (!name) return unprocessable('name is required');
        const existing = repo.labels.get(name);
        if (existing) return ok(201, { id: name.length, name, color: existing.color, default: false, description: '' });
        repo.labels.set(name, { name, color });
        return ok(201, { id: name.length, name, color, default: false, description: '' });
      }
      if (method === 'GET') {
        return ok(200, [...repo.labels.values()].map((l) => ({ id: l.name.length, name: l.name, color: l.color, default: false, description: '' })));
      }
      return notFound();
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const labelNames = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
          for (const label of labelNames) {
            if (!repo.labels.has(label)) return unprocessable(`Unknown label: ${label}`);
          }
          const issue: Issue = {
            number: repo.nextNumber,
            title,
            body: bodyText,
            state: 'open',
            labels: labelNames,
            comments: [],
            seq: store.nextId(),
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          return ok(201, issueJson(repo, issue, baseUrl));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let items = [...repo.issues];
          if (state !== 'all') items = items.filter((i) => i.state === state);
          if (sort === 'created') items.sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          const { page, headers } = paginate(items, query, baseUrl, `/api/v3/repos/${owner}/${name}/issues`);
          return ok(200, page.map((i) => issueJson(repo, i, baseUrl)), headers);
        }
        return notFound();
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return notFound();
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return notFound();
        if (method === 'GET') return ok(200, issueJson(repo, issue, baseUrl));
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return ok(200, issueJson(repo, issue, baseUrl));
        }
        return notFound();
      }
      if (rest[2] === 'comments') {
        if (!issue) return notFound();
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const comment = { id: store.nextId(), body: bodyText };
          issue.comments.push(comment);
          return ok(201, { id: comment.id, node_id: '', body: bodyText, user: userJson(), created_at: FIXED_ISO, updated_at: FIXED_ISO, html_url: '', issue_url: '' });
        }
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({ id: c.id, node_id: '', body: c.body, user: userJson(), created_at: FIXED_ISO, updated_at: FIXED_ISO, html_url: '', issue_url: '' })));
        }
        return notFound();
      }
      return notFound();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : '';
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return unprocessable('head or base branch does not exist');
          const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (existing) return unprocessable('A pull request already exists for this head and base');
          const pull: Pull = {
            number: repo.nextNumber,
            title,
            body: bodyText,
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
          return ok(201, pullJson(repo, pull, baseUrl));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let items = [...repo.pulls];
          if (state === 'open') items = items.filter((p) => p.state === 'open');
          else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
          // state=all: everything
          items.sort((a, c) => c.seq - a.seq);
          const { page, headers } = paginate(items, query, baseUrl, `/api/v3/repos/${owner}/${name}/pulls`);
          return ok(200, page.map((p) => pullJson(repo, p, baseUrl)), headers);
        }
        return notFound();
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return notFound();
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) return notFound();
        if (method === 'GET') return ok(200, pullJson(repo, pull, baseUrl));
        return notFound();
      }
      if (rest[2] === 'files') {
        if (!pull) return notFound();
        if (method !== 'GET') return notFound();
        const baseFiles = flattenTree(repo, treeOidOfCommit(repo, pull.baseSha));
        const headFiles = flattenTree(repo, treeOidOfCommit(repo, pull.headSha));
        const files = diffTrees(baseFiles, headFiles).map((d) => {
          const oldText = blobText(repo, d.baseOid);
          const newText = blobText(repo, d.headOid);
          const { additions, deletions } = d.status === 'added' ? { additions: newText === '' ? 0 : newText.split('\n').length, deletions: 0 } : d.status === 'removed' ? { additions: 0, deletions: oldText === '' ? 0 : oldText.split('\n').length } : lineDiff(oldText, newText);
          return {
            sha: d.headOid ?? d.baseOid ?? '',
            filename: d.path,
            status: d.status,
            additions,
            deletions,
            changes: additions + deletions,
            blob_url: '',
            raw_url: '',
            contents_url: '',
          };
        });
        return ok(200, files);
      }
      if (rest[2] === 'merge') {
        if (!pull) return notFound();
        if (method !== 'PUT') return notFound();
        if (pull.merged) {
          return ok(200, { sha: pull.mergeCommitSha, merged: true, message: `Pull request #${pull.number} merged` });
        }
        const sha = mergePullRequest(repo, pull);
        if (sha === null) return ok(405, { message: 'Merge conflict' });
        return ok(200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
      }
      return notFound();
    }

    return notFound();
  }

  return null;
}
