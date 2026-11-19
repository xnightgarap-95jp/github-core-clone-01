// A small GraphQL executor for the documents the suite actually sends: no
// full schema, no validation pass. It parses the query, resolves the handful
// of root fields (viewer, repository, node, __type, and the five mutations)
// and the fields the checks read, and reports an unknown field as a 200
// with an errors array naming it, the way GitHub does.

import type { Issue, Pull, Repo, Store } from './store.ts';
import { flattenTree, mergeBase } from './gitobj.ts';
import { squashMergePull } from './rest.ts';

// ---------------------------------------------------------------- lexer

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!=@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

export interface Selection {
  kind: 'field' | 'fragment' | 'inline';
  name?: string;
  alias?: string;
  args?: Record<string, GqlValue>;
  selections?: Selection[];
  typeCondition?: string;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, GqlValue>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.value}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.next(); // 'on'
        const typeCondition = this.next().value;
        void typeCondition;
        const selections = this.parseSelectionSet();
        fragments.set(name, selections);
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      let name: string | undefined;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        kind = token.value as 'query' | 'mutation';
        this.next();
        const nextToken = this.peek();
        if (nextToken && nextToken.kind === 'name') {
          name = this.next().value;
        }
      }
      const variables = this.parseVariableDefinitions();
      const selections = this.parseSelectionSet();
      operations.push({ kind, name, variables, selections });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Record<string, GqlValue> {
    const defaults: Record<string, GqlValue> = {};
    if (!this.acceptPunct('(')) return defaults;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const varName = this.next().value;
      this.expectPunct(':');
      // Skip the type: an optional '[', a name, an optional ']', any '!'s.
      this.acceptPunct('[');
      this.next(); // type name
      this.acceptPunct(']');
      while (this.acceptPunct('!')) {
        // non-null marker
      }
      if (this.acceptPunct('=')) {
        defaults[varName] = this.parseValue();
      }
    }
    return defaults;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const nextToken = this.peek() as Token;
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.next().value;
      return { kind: 'fragment', name };
    }
    let name = this.next().value;
    let alias: string | undefined;
    const colon = this.peek();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args: Record<string, GqlValue> | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    // Directives (@skip / @include) are not used by the suite; skip them.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') this.parseArguments();
    }
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.expectPunct('(');
    while (!this.acceptPunct(')')) {
      const name = this.next().value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'punct' && token.value === '$') return { $var: this.next().value } as unknown as GqlValue;
    if (token.kind === 'punct' && token.value === '[') {
      const list: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        list.push(this.parseValue());
      }
      this.next();
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, GqlValue> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.next().value;
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.next();
      return obj;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- executor

export interface GqlNode {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  fragments: Map<string, Selection[]>;
  errors: { message: string }[];
  variables: Record<string, GqlValue>;
}

function resolveVariables(value: GqlValue, variables: Record<string, GqlValue>): GqlValue {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ('$var' in record && typeof record.$var === 'string') {
      return variables[record.$var] ?? null;
    }
    const out: Record<string, GqlValue> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVariables(entry as GqlValue, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
  return value;
}

function asRecord(value: GqlValue | undefined): Record<string, GqlValue> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, GqlValue>;
  }
  return {};
}

function strArg(args: Record<string, GqlValue> | undefined, name: string): string | undefined {
  const value = args?.[name];
  return typeof value === 'string' ? value : undefined;
}

function intArg(args: Record<string, GqlValue> | undefined, name: string): number | undefined {
  const value = args?.[name];
  return typeof value === 'number' ? value : undefined;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'resourcePath', 'closedAt', 'locked', 'isPinned'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'reviews', 'author', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'mergedAt', 'mergeCommit', 'isDraft'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt', 'forkCount', 'stargazerCount'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function decodeGlobalId(id: string): { kind: string; dbId: number; extra?: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const dbId = parseInt(parts[1], 10);
    if (Number.isNaN(dbId)) return null;
    return { kind: parts[0], dbId, extra: parts.length > 2 ? parseInt(parts[2], 10) : undefined };
  } catch {
    return null;
  }
}

function findRepoByDbId(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.dbId === dbId) return repo;
  }
  return undefined;
}

function repoNode(store: Store, repo: Repo): GqlNode {
  return { __typename: 'Repository', repo, store };
}

function issueNode(store: Store, repo: Repo, issue: Issue): GqlNode {
  return { __typename: 'Issue', repo, issue, store };
}

function pullNode(store: Store, repo: Repo, pull: Pull): GqlNode {
  return { __typename: 'PullRequest', repo, pull, store };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqFromCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, GqlValue> | undefined): GqlNode {
  const resolved = args ?? {};
  let issues = [...repo.issues.values()];
  const states = resolved.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : String(state).toLowerCase())));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asRecord(resolved.orderBy);
  const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
  issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const afterSeq = seqFromCursor(strArg(resolved, 'after'));
  if (afterSeq !== null) {
    issues = issues.filter((issue) => (direction === 'DESC' ? issue.seq < afterSeq : issue.seq > afterSeq));
  }
  const first = intArg(resolved, 'first');
  const page = first === undefined ? issues : issues.slice(0, first);
  const hasNextPage = first !== undefined && issues.length > first;
  const last = page[page.length - 1];
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(store, repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      endCursor: last ? cursorFor(last.seq) : null,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
    },
    totalCount: issues.length,
  };
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, GqlValue> | undefined): GqlNode {
  const resolved = args ?? {};
  let pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
  const first = intArg(resolved, 'first');
  const page = first === undefined ? pulls : pulls.slice(0, first);
  const hasNextPage = first !== undefined && pulls.length > first;
  const last = page[page.length - 1];
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(store, repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      endCursor: last ? cursorFor(last.seq) : null,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
    },
    totalCount: pulls.length,
  };
}

function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return 'UNKNOWN';
  const baseFlat = flattenTree(repo, base);
  const headFlat = flattenTree(repo, headSha);
  const baseTipFlat = flattenTree(repo, baseSha);
  const paths = new Set([...headFlat.keys(), ...baseTipFlat.keys()]);
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    const inTip = baseTipFlat.get(path);
    const headChanged = (inHead?.oid ?? null) !== (inBase?.oid ?? null);
    const tipChanged = (inTip?.oid ?? null) !== (inBase?.oid ?? null);
    if (headChanged && tipChanged && (inHead?.oid ?? null) !== (inTip?.oid ?? null)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullFilesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, GqlValue> | undefined): GqlNode {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headSha, baseSha);
  const baseFlat = base === null ? new Map() : flattenTree(repo, base);
  const headFlat = flattenTree(repo, headSha);
  const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort();
  const changed = paths.filter((path) => (baseFlat.get(path)?.oid ?? null) !== (headFlat.get(path)?.oid ?? null));
  const first = intArg(args, 'first');
  const page = first === undefined ? changed : changed.slice(0, first);
  return {
    __typename: 'PullRequestFileConnection',
    nodes: page.map((path) => ({ __typename: 'PullRequestFile', path })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && changed.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
    totalCount: changed.length,
  };
}

function typeNode(name: string): GqlNode {
  if (name === 'Issue') {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: ISSUE_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'PullRequest') {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'Repository') {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'SearchType') {
    return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) };
  }
  return { __typename: '__Type', name, kind: null, fields: null, enumValues: null };
}

/** Resolve one field on a node. Returns undefined when the field does not
 *  exist on that type, so the caller can record an error naming it. */
function resolveField(ctx: ExecContext, parent: GqlNode, field: Selection): unknown {
  const store = ctx.store;
  const name = field.name as string;
  const args = field.args === undefined ? undefined : (resolveVariables(field.args, ctx.variables) as Record<string, GqlValue>);
  switch (parent.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'Viewer', login: store.viewer() };
      if (name === 'repository') {
        const owner = strArg(args, 'owner');
        const repoName = strArg(args, 'name');
        if (!owner || !repoName) return null;
        const repo = store.resolve(owner, repoName);
        return repo ? repoNode(store, repo) : null;
      }
      if (name === 'node') {
        const id = strArg(args, 'id');
        if (!id) return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        const repo = findRepoByDbId(store, decoded.dbId);
        if (!repo) return null;
        if (decoded.kind === 'repo') return repoNode(store, repo);
        if (decoded.kind === 'issue' && decoded.extra !== undefined) {
          const issue = repo.issues.get(decoded.extra);
          return issue ? issueNode(store, repo, issue) : null;
        }
        if (decoded.kind === 'pull' && decoded.extra !== undefined) {
          const pull = repo.pulls.get(decoded.extra);
          return pull ? pullNode(store, repo, pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = strArg(args, 'name');
        return typeName ? typeNode(typeName) : null;
      }
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = asRecord(args?.input);
        const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : undefined;
        const decoded = repositoryId ? decodeGlobalId(repositoryId) : null;
        const repo = decoded ? findRepoByDbId(store, decoded.dbId) : undefined;
        if (!repo) return null;
        const number = store.nextNumber(repo);
        const issue: Issue = {
          id: store.globalId('issue', repo.dbId, number),
          number,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          seq: number,
        };
        repo.issues.set(number, issue);
        return { __typename: 'CreateIssuePayload', issue: issueNode(store, repo, issue) };
      }
      if (name === 'closeIssue') {
        const input = asRecord(args?.input);
        const issueId = typeof input.issueId === 'string' ? input.issueId : undefined;
        const decoded = issueId ? decodeGlobalId(issueId) : null;
        const repo = decoded ? findRepoByDbId(store, decoded.dbId) : undefined;
        const issue = repo && decoded?.extra !== undefined ? repo.issues.get(decoded.extra) : undefined;
        if (!repo || !issue) return null;
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueNode(store, repo, issue) };
      }
      if (name === 'createPullRequest') {
        const input = asRecord(args?.input);
        const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : undefined;
        const decoded = repositoryId ? decodeGlobalId(repositoryId) : null;
        const repo = decoded ? findRepoByDbId(store, decoded.dbId) : undefined;
        if (!repo) return null;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return null;
        const number = store.nextNumber(repo);
        const pull: Pull = {
          id: store.globalId('pull', repo.dbId, number),
          number,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          head,
          base,
          headSha,
          baseSha,
          seq: number,
        };
        repo.pulls.set(number, pull);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(store, repo, pull) };
      }
      if (name === 'mergePullRequest') {
        const input = asRecord(args?.input);
        const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : undefined;
        const decoded = pullRequestId ? decodeGlobalId(pullRequestId) : null;
        const repo = decoded ? findRepoByDbId(store, decoded.dbId) : undefined;
        const pull = repo && decoded?.extra !== undefined ? repo.pulls.get(decoded.extra) : undefined;
        if (!repo || !pull) return null;
        squashMergePull(repo, pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pull) };
      }
      if (name === 'addComment') {
        const input = asRecord(args?.input);
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : undefined;
        const body = typeof input.body === 'string' ? input.body : '';
        const decoded = subjectId ? decodeGlobalId(subjectId) : null;
        const repo = decoded ? findRepoByDbId(store, decoded.dbId) : undefined;
        const issue = repo && decoded?.extra !== undefined ? repo.issues.get(decoded.extra) : undefined;
        if (!repo || !issue) return null;
        repo.commentCounter += 1;
        const comment = { id: repo.commentCounter, body, user: store.viewer() };
        issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: String(comment.id), body: comment.body } },
        };
      }
      return undefined;
    }
    case 'Viewer':
    case 'User': {
      if (name === 'login') return parent.login ?? store.viewer();
      return undefined;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (name === 'id') return store.globalId('repo', repo.dbId);
      if (name === 'databaseId') return repo.dbId;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner };
      if (name === 'description') return repo.description;
      if (name === 'private' || name === 'isPrivate') return repo.isPrivate;
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } } : null;
      }
      if (name === 'issue') {
        const number = intArg(args, 'number');
        if (number === undefined) return null;
        const issue = repo.issues.get(number);
        return issue ? issueNode(store, repo, issue) : null;
      }
      if (name === 'issues') return issuesConnection(store, repo, args);
      if (name === 'pullRequest') {
        const number = intArg(args, 'number');
        if (number === undefined) return null;
        const pull = repo.pulls.get(number);
        return pull ? pullNode(store, repo, pull) : null;
      }
      if (name === 'pullRequests') return pullsConnection(store, repo, args);
      return undefined;
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      if (name === 'id') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      return undefined;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (name === 'id') return pull.id;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.head;
      if (name === 'baseRefName') return pull.base;
      if (name === 'mergeable') return pullMergeable(store, repo, pull);
      if (name === 'files') return pullFilesConnection(store, repo, pull, args);
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (name === 'nodes') return parent.nodes as GqlNode[];
      if (name === 'pageInfo') return parent.pageInfo as GqlNode;
      if (name === 'totalCount') return parent.totalCount as number;
      return undefined;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage as boolean;
      if (name === 'hasPreviousPage') return parent.hasPreviousPage as boolean;
      if (name === 'endCursor') return parent.endCursor as string | null;
      if (name === 'startCursor') return parent.startCursor as string | null;
      return undefined;
    }
    case 'Ref': {
      if (name === 'name') return parent.name as string;
      return undefined;
    }
    case 'PullRequestFile': {
      if (name === 'path') return parent.path as string;
      return undefined;
    }
    case '__Type': {
      if (name === 'name') return parent.name as string;
      if (name === 'kind') return parent.kind as string | null;
      if (name === 'fields') return parent.fields as GqlNode[] | null;
      if (name === 'enumValues') return parent.enumValues as GqlNode[] | null;
      return undefined;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return parent.name as string;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue as GqlNode;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest as GqlNode;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge as GqlNode;
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return parent.node as GqlNode;
      return undefined;
    }
    case 'IssueComment': {
      if (name === 'id') return parent.id as string;
      if (name === 'body') return parent.body as string;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executeSelections(ctx: ExecContext, parent: GqlNode, selections: Selection[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragmentSelections = ctx.fragments.get(selection.name as string);
      if (fragmentSelections) {
        Object.assign(result, executeSelections(ctx, parent, fragmentSelections));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === parent.__typename) {
        Object.assign(result, executeSelections(ctx, parent, selection.selections ?? []));
      }
      continue;
    }
    const responseKey = selection.alias ?? (selection.name as string);
    const value = resolveField(ctx, parent, selection);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.__typename}".` });
      result[responseKey] = null;
      continue;
    }
    result[responseKey] = completeValue(ctx, value, selection.selections);
  }
  return result;
}

function completeValue(ctx: ExecContext, value: unknown, selections: Selection[] | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(ctx, entry, selections));
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (!selections || selections.length === 0) return null;
    return executeSelections(ctx, value as GqlNode, selections);
  }
  return value;
}

export interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(store: Store, body: unknown): GqlResponse | GqlResponse[] {
  if (Array.isArray(body)) {
    return body.map((operation) => executeOne(store, operation));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): GqlResponse {
  const record = (body ?? {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, GqlValue>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  let parsed: { operations: Operation[]; fragments: Map<string, Selection[]> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operation = operationName
    ? parsed.operations.find((op) => op.name === operationName) ?? parsed.operations[0]
    : parsed.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  const mergedVariables: Record<string, GqlValue> = { ...operation.variables, ...variables };
  const ctx: ExecContext = { store, fragments: parsed.fragments, errors: [], variables: mergedVariables };
  const root: GqlNode = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(ctx, root, operation.selections);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  return { data };
}
