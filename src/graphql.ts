// graphql.ts — GitHub GraphQL v4 for the fixed document set the suite sends:
// viewer/repository/node/__type queries, issue & pull-request connections with cursor
// pagination, and the five mutations. Hand-rolled lexer/parser/executor, no deps.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  b64url,
  diffTrees,
  flattenTree,
  issueGlobalId,
  parseCommit,
  pullGlobalId,
  repoGlobalId,
  unb64url,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './core.ts';
import { isConflicted, mergePullRequest } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      push('spread', '...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      push('string', out);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j += 1;
      const raw = input.slice(i, j);
      push(raw.includes('.') ? 'float' : 'int', raw);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      push('name', input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }
  push('eof', '');
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type GValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GValue[] }
  | { kind: 'object'; fields: Record<string, GValue> };

export interface GField {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Record<string, GValue>;
  selections: GSelection[] | undefined;
}
export interface GFragmentSpread {
  kind: 'spread';
  name: string;
}
export interface GInlineFragment {
  kind: 'inline';
  typeCondition: string | undefined;
  selections: GSelection[];
}
export type GSelection = GField | GFragmentSpread | GInlineFragment;

export interface GOperation {
  type: 'query' | 'mutation';
  name: string | undefined;
  varDefs: Record<string, GValue | undefined>;
  selections: GSelection[];
}

export interface GDocument {
  operations: GOperation[];
  fragments: Map<string, { typeCondition: string | undefined; selections: GSelection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`graphql: expected ${value}, got ${t.value}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`graphql: expected name, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`graphql: expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): GDocument {
    const operations: GOperation[] = [];
    const fragments = new Map<string, { typeCondition: string | undefined; selections: GSelection[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        operations.push({ type: 'query', name: undefined, varDefs: {}, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        let typeCondition: string | undefined;
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        this.skipDirectives();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`graphql: unexpected ${keyword}`);
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const varDefs: Record<string, GValue | undefined> = {};
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.parseVarDefs(varDefs);
      }
      this.skipDirectives();
      operations.push({ type: keyword, name, varDefs, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private parseVarDefs(varDefs: Record<string, GValue | undefined>): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        varDefs[name] = this.parseValue();
      } else {
        varDefs[name] = undefined;
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): GSelection[] {
    this.expectPunct('{');
    const selections: GSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: undefined, selections: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | undefined;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : {};
      this.skipDirectives();
      const selections2 = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, selections: selections2 });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseArguments(): Record<string, GValue> {
    const args: Record<string, GValue> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, GValue> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`graphql: unexpected value token ${t.value}`);
  }
}

function resolveValue(value: GValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

const UNKNOWN = Symbol('unknown');

interface GNode {
  __typename: string;
  field(name: string, args: Record<string, unknown>): unknown;
}

function scalarNode(typename: string, fields: Record<string, unknown>): GNode {
  return {
    __typename: typename,
    field(name: string): unknown {
      if (name in fields) return fields[name];
      return UNKNOWN;
    },
  };
}

interface GqlContext {
  store: Store;
  baseUrl: string;
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number: number; commentId: number } | null {
  try {
    const text = unb64url(id);
    const parts = text.split(':');
    if (parts[0] === 'R' && parts.length === 2) return { kind: 'R', repoId: parseInt(parts[1], 10), number: 0, commentId: 0 };
    if (parts[0] === 'I' && parts.length === 3) return { kind: 'I', repoId: parseInt(parts[1], 10), number: parseInt(parts[2], 10), commentId: 0 };
    if (parts[0] === 'P' && parts.length === 3) return { kind: 'P', repoId: parseInt(parts[1], 10), number: parseInt(parts[2], 10), commentId: 0 };
    if (parts[0] === 'C' && parts.length === 4) return { kind: 'C', repoId: parseInt(parts[1], 10), number: parseInt(parts[2], 10), commentId: parseInt(parts[3], 10) };
    return null;
  } catch {
    return null;
  }
}

function treeOidOfCommit(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

function userNode(): GNode {
  return scalarNode('User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, databaseId: VIEWER_ID });
}

function issueNode(repo: Repo, issue: Issue): GNode {
  return scalarNode('Issue', {
    id: issueGlobalId(repo, issue.number),
    databaseId: issue.seq + 100000,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

function pullNode(repo: Repo, pull: Pull): GNode {
  const node: GNode = {
    __typename: 'PullRequest',
    field(name: string, args: Record<string, unknown>): unknown {
      switch (name) {
        case 'id':
          return pullGlobalId(repo, pull.number);
        case 'databaseId':
          return pull.seq + 100000;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pull.state === 'open' ? (isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'MERGEABLE';
        case 'merged':
          return pull.merged;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const baseFiles = flattenTree(repo, treeOidOfCommit(repo, pull.baseSha));
          const headFiles = flattenTree(repo, treeOidOfCommit(repo, pull.headSha));
          const paths = diffTrees(baseFiles, headFiles).map((d) => d.path);
          const nodes = paths.slice(0, first).map((p) => scalarNode('PullRequestChangedFile', { path: p }));
          return connectionNode('PullRequestChangedFileConnection', nodes, paths.length > first, paths.length > 0 ? b64url(`cursor:${first}`) : null, paths.length);
        }
        default:
          return UNKNOWN;
      }
    },
  };
  return node;
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null): GNode {
  return scalarNode('PageInfo', { hasNextPage, endCursor, hasPreviousPage: false, startCursor: null });
}

function connectionNode(typename: string, nodes: GNode[], hasNextPage: boolean, endCursor: string | null, totalCount: number): GNode {
  return scalarNode(typename, { nodes, pageInfo: pageInfoNode(hasNextPage, endCursor), totalCount, edges: nodes.map((n) => scalarNode('Edge', { node: n, cursor: endCursor })) });
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GNode {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  let items = [...repo.issues];
  if (states) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
    items = items.filter((i) => wanted.has(i.state));
  }
  items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const after = typeof args.after === 'string' && args.after ? decodeCursor(args.after) : null;
  if (after !== null) {
    const idx = items.findIndex((i) => i.seq === after);
    if (idx >= 0) items = items.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNext = items.length > first;
  const endCursor = page.length ? b64url(`cursor:${page[page.length - 1].seq}`) : null;
  return connectionNode('IssueConnection', page.map((i) => issueNode(repo, i)), hasNext, endCursor, items.length);
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = unb64url(cursor);
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GNode {
  const items = [...repo.pulls].sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNext = items.length > first;
  const endCursor = page.length ? b64url(`cursor:${page[page.length - 1].seq}`) : null;
  return connectionNode('PullRequestConnection', page.map((p) => pullNode(repo, p)), hasNext, endCursor, items.length);
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'databaseId'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
};

function typeNode(name: string): GNode | null {
  if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) return null;
  const fields = (TYPE_FIELDS[name] ?? []).map((f) => scalarNode('__Field', { name: f }));
  const enumValues = (TYPE_ENUM_VALUES[name] ?? []).map((v) => scalarNode('__EnumValue', { name: v }));
  return scalarNode('__Type', {
    name,
    kind: name in TYPE_ENUM_VALUES ? 'ENUM' : 'OBJECT',
    fields,
    enumValues,
  });
}

function repositoryNode(ctx: GqlContext, repo: Repo): GNode {
  const node: GNode = {
    __typename: 'Repository',
    field(name: string, args: Record<string, unknown>): unknown {
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userNode();
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? scalarNode('Ref', { name: repo.defaultBranch }) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const num = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.find((i) => i.number === num);
          return issue ? issueNode(repo, issue) : null;
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequests':
          return pullsConnection(repo, args);
        case 'pullRequest': {
          const num = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.find((p) => p.number === num);
          return pull ? pullNode(repo, pull) : null;
        }
        default:
          return UNKNOWN;
      }
    },
  };
  return node;
}

function nodeByGlobalId(ctx: GqlContext, id: string): GNode | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const repo = findRepoById(ctx.store, decoded.repoId);
  if (!repo) return null;
  if (decoded.kind === 'R') return repositoryNode(ctx, repo);
  if (decoded.kind === 'I') {
    const issue = repo.issues.find((i) => i.number === decoded.number);
    return issue ? issueNode(repo, issue) : null;
  }
  if (decoded.kind === 'P') {
    const pull = repo.pulls.find((p) => p.number === decoded.number);
    return pull ? pullNode(repo, pull) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

class GqlError extends Error {}

function createIssue(ctx: GqlContext, input: Record<string, unknown>): GNode {
  const repo = findRepoById(ctx.store, decodeGlobalId(String(input.repositoryId ?? ''))?.repoId ?? -1);
  if (!repo) throw new GqlError('Repository not found');
  const title = typeof input.title === 'string' ? input.title : '';
  const bodyText = typeof input.body === 'string' ? input.body : '';
  const issue: Issue = { number: repo.nextNumber, title, body: bodyText, state: 'open', labels: [], comments: [], seq: ctx.store.nextId() };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return scalarNode('CreateIssuePayload', { issue: issueNode(repo, issue) });
}

function closeIssue(ctx: GqlContext, input: Record<string, unknown>): GNode {
  const decoded = decodeGlobalId(String(input.issueId ?? ''));
  if (!decoded || decoded.kind !== 'I') throw new GqlError('Issue not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (!issue) throw new GqlError('Issue not found');
  issue.state = 'closed';
  return scalarNode('CloseIssuePayload', { issue: issueNode(repo as Repo, issue) });
}

function createPullRequest(ctx: GqlContext, input: Record<string, unknown>): GNode {
  const repo = findRepoById(ctx.store, decodeGlobalId(String(input.repositoryId ?? ''))?.repoId ?? -1);
  if (!repo) throw new GqlError('Repository not found');
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const title = typeof input.title === 'string' ? input.title : '';
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new GqlError('head or base branch does not exist');
  const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (existing) return scalarNode('CreatePullRequestPayload', { pullRequest: pullNode(repo, existing) });
  const pull: Pull = {
    number: repo.nextNumber,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: ctx.store.nextId(),
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return scalarNode('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull) });
}

function mergePullRequestMutation(ctx: GqlContext, input: Record<string, unknown>): GNode {
  const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
  if (!decoded || decoded.kind !== 'P') throw new GqlError('Pull request not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  const pull = repo?.pulls.find((p) => p.number === decoded.number);
  if (!pull || !repo) throw new GqlError('Pull request not found');
  if (!pull.merged) {
    const sha = mergePullRequest(repo, pull);
    if (sha === null) throw new GqlError('Merge conflict');
  }
  return scalarNode('MergePullRequestPayload', { pullRequest: pullNode(repo, pull) });
}

function addComment(ctx: GqlContext, input: Record<string, unknown>): GNode {
  const decoded = decodeGlobalId(String(input.subjectId ?? ''));
  if (!decoded || (decoded.kind !== 'I' && decoded.kind !== 'P')) throw new GqlError('Subject not found');
  const repo = findRepoById(ctx.store, decoded.repoId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (!issue || !repo) throw new GqlError('Subject not found');
  const bodyText = typeof input.body === 'string' ? input.body : '';
  const comment = { id: ctx.store.nextId(), body: bodyText };
  issue.comments.push(comment);
  const node = scalarNode('IssueComment', { id: `${repo.id}:${issue.number}:${comment.id}`, databaseId: comment.id, body: bodyText });
  const edge = scalarNode('IssueCommentEdge', { node, cursor: b64url(`cursor:${comment.id}`) });
  return scalarNode('AddCommentPayload', { commentEdge: edge });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecState {
  errors: Array<{ message: string }>;
  doc: GDocument;
  variables: Record<string, unknown>;
  ctx: GqlContext;
}

function executeSelections(node: GNode, selections: GSelection[], state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = state.doc.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition && frag.typeCondition !== node.__typename) continue;
      Object.assign(out, executeSelections(node, frag.selections, state));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== node.__typename) continue;
      Object.assign(out, executeSelections(node, sel.selections, state));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = node.__typename;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, state.variables);
    let value: unknown;
    try {
      value = node.field(sel.name, args);
    } catch (err) {
      if (err instanceof GqlError) {
        state.errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (value === UNKNOWN) {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "${node.__typename}".` });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(value, sel.selections, state);
  }
  return out;
}

function executeValue(value: unknown, selections: GSelection[] | undefined, state: ExecState): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => executeValue(v, selections, state));
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (!selections) return {};
    return executeSelections(value as GNode, selections, state);
  }
  return value;
}

function rootNode(ctx: GqlContext, type: 'query' | 'mutation'): GNode {
  const node: GNode = {
    __typename: type === 'query' ? 'Query' : 'Mutation',
    field(name: string, args: Record<string, unknown>): unknown {
      if (type === 'query') {
        switch (name) {
          case 'viewer':
            return userNode();
          case 'repository': {
            const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
            return repo ? repositoryNode(ctx, repo) : null;
          }
          case 'node':
            return nodeByGlobalId(ctx, String(args.id ?? ''));
          case '__type': {
            const t = typeNode(String(args.name ?? ''));
            return t;
          }
          default:
            return UNKNOWN;
        }
      }
      switch (name) {
        case 'createIssue':
          return createIssue(ctx, (args.input ?? {}) as Record<string, unknown>);
        case 'closeIssue':
          return closeIssue(ctx, (args.input ?? {}) as Record<string, unknown>);
        case 'createPullRequest':
          return createPullRequest(ctx, (args.input ?? {}) as Record<string, unknown>);
        case 'mergePullRequest':
          return mergePullRequestMutation(ctx, (args.input ?? {}) as Record<string, unknown>);
        case 'addComment':
          return addComment(ctx, (args.input ?? {}) as Record<string, unknown>);
        default:
          return UNKNOWN;
      }
    },
  };
  return node;
}

function executeOperation(ctx: GqlContext, doc: GDocument, op: GOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const state: ExecState = { errors: [], doc, variables, ctx };
  const data = executeSelections(rootNode(ctx, op.type), op.selections, state);
  const out: Record<string, unknown> = { data };
  if (state.errors.length) out.errors = state.errors;
  return out;
}

/** Execute one GraphQL request body (object or array of operations). */
export function handleGraphQL(ctx: GqlContext, body: unknown): unknown {
  const runOne = (req: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof req.query === 'string' ? req.query : '';
    const variables = (req.variables ?? {}) as Record<string, unknown>;
    if (!query) return { data: null, errors: [{ message: 'Must provide query string.' }] };
    let doc: GDocument;
    try {
      doc = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    let op = doc.operations[0];
    if (typeof req.operationName === 'string') {
      op = doc.operations.find((o) => o.name === req.operationName) ?? op;
    }
    if (!op) return { data: null, errors: [{ message: 'No operation provided.' }] };
    try {
      return executeOperation(ctx, doc, op, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
    }
  };
  if (Array.isArray(body)) return body.map((item) => runOne((item ?? {}) as Record<string, unknown>));
  return runOne((body ?? {}) as Record<string, unknown>);
}
