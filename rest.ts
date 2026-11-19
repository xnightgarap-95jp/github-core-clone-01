// GitHub REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is JSON, carries a
// non-empty X-GitHub-Request-Id, and uses the status codes a real GitHub
// client expects (201 create, 204 delete, 401 no token, 404 unknown,
// 409 stale sha, 422 validation).

import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import type { HttpReply } from './githttp.ts';
import { jsonReply } from './githttp.ts';
import {
  ZERO_OID,
  objectId,
  parseCommit,
  parseTree,
  flattenTree,
  mergeBase,
} from './gitobj.ts';
import { commitChanges } from './githttp.ts';

export interface RestCtx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string;
}

function notFound(message = 'Not Found'): HttpReply {
  return jsonReply(404, { message });
}

function badRequest(message: string): HttpReply {
  return jsonReply(400, { message });
}

function unprocessable(message: string): HttpReply {
  return jsonReply(422, { message });
}

function conflict(message: string): HttpReply {
  return jsonReply(409, { message });
}

function parseJsonBody(ctx: RestCtx): { ok: true; value: Record<string, unknown> } | { ok: false; reply: HttpReply } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false, reply: badRequest('request body must be a JSON object') };
  } catch {
    return { ok: false, reply: badRequest('request body is not valid JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------- shapes

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: store.globalId('repo', repo.dbId),
    databaseId: repo.dbId,
    node_id: store.globalId('repo', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
    pushed_at: '1970-01-01T00:00:00Z',
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: store.viewer(), id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: store.viewer(), id: 1, type: 'User' },
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- pagination

interface PageResult<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(ctx: RestCtx, path: string, all: T[]): PageResult<T> {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const url = (p: number): string => `${ctx.baseUrl}${path}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(totalPages)}>; rel="last"`);
  return { items, link: links.join(', ') };
}

export interface PagedReply<T> {
  reply: HttpReply;
  link: string | null;
}

function pagedJson<T>(ctx: RestCtx, path: string, all: T[]): PagedReply<T> {
  const { items, link } = paginate(ctx, path, all);
  return { reply: jsonReply(200, items), link };
}

// ---------------------------------------------------------------- routing

export function handleRest(ctx: RestCtx): { reply: HttpReply; link?: string } {
  const [first, second, ...rest] = ctx.segments;
  if (first === undefined) {
    return { reply: jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }) };
  }
  if (first === 'meta') {
    return { reply: jsonReply(200, { installed_version: '1.0.0' }) };
  }
  if (first === 'user') {
    return handleUser(ctx, second, rest);
  }
  if (first === 'repos') {
    return handleRepos(ctx, second, rest);
  }
  return { reply: notFound() };
}

function handleUser(ctx: RestCtx, second: string | undefined, rest: string[]): { reply: HttpReply; link?: string } {
  const store = ctx.store;
  if (second === undefined) {
    if (ctx.method !== 'GET') return { reply: notFound() };
    if (store.viewerLogin === null) return { reply: notFound('Not Found') };
    return {
      reply: jsonReply(200, {
        login: store.viewer(),
        id: 1,
        type: 'User',
        html_url: `https://github.com/${store.viewer()}`,
        url: '/api/v3/user',
      }),
    };
  }
  if (second === 'repos') {
    if (ctx.method === 'GET') {
      const path = '/api/v3/user/repos';
      const repos = store.listViewerRepos().map((repo) => repoJson(store, repo));
      const paged = pagedJson(ctx, path, repos);
      return { reply: paged.reply, link: paged.link ?? undefined };
    }
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return { reply: parsed.reply };
      const name = asString(parsed.value.name);
      if (!name) return { reply: unprocessable('name is required') };
      const repo = store.createRepo(
        name,
        asString(parsed.value.description) ?? '',
        asBoolean(parsed.value.private) ?? false,
      );
      if (!repo) return { reply: unprocessable('a repository with this name already exists') };
      return { reply: jsonReply(201, repoJson(store, repo)) };
    }
  }
  return { reply: notFound() };
}

function resolveRepo(ctx: RestCtx, owner: string | undefined, name: string | undefined): Repo | null {
  if (owner === undefined || name === undefined) return null;
  return ctx.store.resolve(owner, name);
}

function handleRepos(ctx: RestCtx, owner: string | undefined, rest: string[]): { reply: HttpReply; link?: string } {
  const [name, ...tail] = rest;
  const repo = resolveRepo(ctx, owner, name);
  if (!repo) return { reply: notFound() };
  if (tail.length === 0) {
    if (ctx.method === 'GET') return { reply: jsonReply(200, repoJson(ctx.store, repo)) };
    if (ctx.method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return { reply: parsed.reply };
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      return { reply: jsonReply(200, repoJson(ctx.store, repo)) };
    }
    if (ctx.method === 'DELETE') {
      ctx.store.deleteRepo(repo.name);
      return { reply: { status: 204, contentType: 'application/json', body: Buffer.alloc(0) } };
    }
    return { reply: notFound() };
  }
  const [section, ...sub] = tail;
  if (section === 'branches') return handleBranches(ctx, repo, sub);
  if (section === 'commits') return handleCommits(ctx, repo);
  if (section === 'git') return handleGitRefs(ctx, repo, sub);
  if (section === 'contents') return handleContents(ctx, repo, sub);
  if (section === 'labels') return handleLabels(ctx, repo);
  if (section === 'issues') return handleIssues(ctx, repo, sub);
  if (section === 'pulls') return handlePulls(ctx, repo, sub);
  return { reply: notFound() };
}

// ---------------------------------------------------------------- branches & commits

function handleBranches(ctx: RestCtx, repo: Repo, sub: string[]): { reply: HttpReply } {
  if (ctx.method === 'GET' && sub.length === 0) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID },
        protected: false,
      }));
    return { reply: jsonReply(200, branches) };
  }
  if (ctx.method === 'GET' && sub.length === 1) {
    const branch = sub[0];
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return { reply: notFound() };
    return { reply: jsonReply(200, { name: branch, commit: { sha }, protected: false }) };
  }
  return { reply: notFound() };
}

function parseIdent(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (!match) return { name: raw, email: '', date: '1970-01-01T00:00:00Z' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function handleCommits(ctx: RestCtx, repo: Repo): { reply: HttpReply } {
  if (ctx.method !== 'GET') return { reply: notFound() };
  const refParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (refParam === undefined) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  } else if (repo.refs.has(`refs/heads/${refParam}`)) {
    tip = repo.refs.get(`refs/heads/${refParam}`);
  } else if (repo.objects.has(refParam)) {
    tip = refParam;
  }
  if (!tip) return { reply: jsonReply(200, []) };
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 1) continue;
    order.push(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  const commits = order.map((oid) => {
    const obj = repo.objects.get(oid) as { type: number; data: Buffer };
    const parsed = parseCommit(obj.data);
    const text = obj.data.toString('utf8');
    const authorLine = /^author (.*)$/m.exec(text)?.[1] ?? '';
    const committerLine = /^committer (.*)$/m.exec(text)?.[1] ?? authorLine;
    return {
      sha: oid,
      commit: {
        message: parsed.message,
        tree: { sha: parsed.tree },
        author: parseIdent(authorLine),
        committer: parseIdent(committerLine),
      },
    };
  });
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/commits`;
  const paged = pagedJson(ctx, path, commits);
  return { reply: paged.reply, link: paged.link ?? undefined };
}

function handleGitRefs(ctx: RestCtx, repo: Repo, sub: string[]): { reply: HttpReply } {
  if (sub[0] !== 'refs') return { reply: notFound() };
  if (ctx.method === 'POST' && sub.length === 1) {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return { reply: parsed.reply };
    const ref = asString(parsed.value.ref);
    const sha = asString(parsed.value.sha);
    if (!ref || !sha) return { reply: unprocessable('ref and sha are required') };
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 1) return { reply: unprocessable('sha is not a commit') };
    if (repo.refs.has(ref)) return { reply: unprocessable('reference already exists') };
    repo.refs.set(ref, sha);
    return { reply: jsonReply(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } }) };
  }
  if (ctx.method === 'GET' && sub[1] === 'heads' && sub.length === 3) {
    const branch = sub[2];
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return { reply: notFound() };
    return { reply: jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }) };
  }
  return { reply: notFound() };
}

// ---------------------------------------------------------------- contents

function refTip(repo: Repo, branch: string | undefined): string | undefined {
  const name = branch ?? repo.defaultBranch;
  return repo.refs.get(`refs/heads/${name}`);
}

/** The tree oid at a path inside a commit, or null when the path is not a
 *  directory in that tree. */
function treeOidAtPath(repo: Repo, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 1) return null;
  let current = parseCommit(commit.data).tree;
  if (path === '') return current;
  for (const segment of path.split('/')) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 2) return null;
    const entry = parseTree(tree.data).find((item) => item.name === segment && item.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function handleContents(ctx: RestCtx, repo: Repo, sub: string[]): { reply: HttpReply } {
  const path = sub.map((segment) => decodeURIComponent(segment)).join('/');
  const branch = asString(ctx.query.get('ref')) ?? undefined;
  if (ctx.method === 'GET') {
    const tip = refTip(repo, branch);
    if (!tip) return { reply: notFound() };
    const flat = flattenTree(repo, tip);
    const exact = flat.get(path);
    if (exact) {
      const blob = repo.objects.get(exact.oid);
      const data = blob ? blob.data : Buffer.alloc(0);
      return {
        reply: jsonReply(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop() ?? path,
          path,
          content: data.toString('base64'),
          sha: exact.oid,
        }),
      };
    }
    // Directory listing: the tree object at the path (empty path = root).
    // Entries carry their real object ids, as GitHub does.
    const treeOid = treeOidAtPath(repo, tip, path);
    if (treeOid === null) return { reply: notFound() };
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 2) return { reply: notFound() };
    const listing = parseTree(treeObj.data)
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((entry) => {
        if (entry.mode === '40000') {
          return { type: 'dir', name: entry.name, path: path === '' ? entry.name : `${path}/${entry.name}`, sha: entry.oid };
        }
        const blob = repo.objects.get(entry.oid);
        return {
          type: 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          size: blob ? blob.data.length : 0,
        };
      });
    return { reply: jsonReply(200, listing) };
  }
  if (ctx.method === 'PUT') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return { reply: parsed.reply };
    const message = asString(parsed.value.message) ?? 'update file';
    const content = asString(parsed.value.content);
    if (content === undefined) return { reply: unprocessable('content is required') };
    const branchName = asString(parsed.value.branch) ?? repo.defaultBranch;
    const tip = refTip(repo, branchName);
    const flat = tip === undefined ? new Map() : flattenTree(repo, tip);
    const current = flat.get(path);
    const sha = asString(parsed.value.sha);
    if (sha !== undefined) {
      if (!current || current.oid !== sha) return { reply: conflict('sha does not match the current file') };
    } else if (current) {
      return { reply: unprocessable('file already exists') };
    }
    const bytes = Buffer.from(content, 'base64');
    const changes = new Map<string, Buffer | null>([[path, bytes]]);
    const commitOid = commitChanges(repo, branchName, message, changes);
    if (commitOid === null) return { reply: conflict('branch tip changed') };
    const blobOid = objectId('blob', bytes);
    const status = current ? 200 : 201;
    return {
      reply: jsonReply(status, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitOid, message },
      }),
    };
  }
  if (ctx.method === 'DELETE') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return { reply: parsed.reply };
    const message = asString(parsed.value.message) ?? 'delete file';
    const branchName = asString(parsed.value.branch) ?? repo.defaultBranch;
    const tip = refTip(repo, branchName);
    if (!tip) return { reply: notFound() };
    const flat = flattenTree(repo, tip);
    const current = flat.get(path);
    if (!current) return { reply: notFound() };
    const sha = asString(parsed.value.sha);
    if (sha !== undefined && current.oid !== sha) return { reply: conflict('sha does not match the current file') };
    const changes = new Map<string, Buffer | null>([[path, null]]);
    const commitOid = commitChanges(repo, branchName, message, changes);
    if (commitOid === null) return { reply: conflict('branch tip changed') };
    return { reply: jsonReply(200, { commit: { sha: commitOid, message } }) };
  }
  return { reply: notFound() };
}

// ---------------------------------------------------------------- labels

function handleLabels(ctx: RestCtx, repo: Repo): { reply: HttpReply } {
  if (ctx.method === 'GET') {
    return { reply: jsonReply(200, [...repo.labels.values()].map(labelJson)) };
  }
  if (ctx.method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return { reply: parsed.reply };
    const name = asString(parsed.value.name);
    if (!name) return { reply: unprocessable('name is required') };
    const existing = repo.labels.get(name);
    if (existing) return { reply: jsonReply(200, labelJson(existing)) };
    const label: Label = { name, color: asString(parsed.value.color) ?? 'ededed' };
    repo.labels.set(name, label);
    return { reply: jsonReply(201, labelJson(label)) };
  }
  return { reply: notFound() };
}

// ---------------------------------------------------------------- issues

function handleIssues(ctx: RestCtx, repo: Repo, sub: string[]): { reply: HttpReply; link?: string } {
  const store = ctx.store;
  if (sub.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const path = `/api/v3/repos/${repo.owner}/${repo.name}/issues`;
      const paged = pagedJson(ctx, path, issues.map((issue) => issueJson(store, repo, issue)));
      return { reply: paged.reply, link: paged.link ?? undefined };
    }
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return { reply: parsed.reply };
      const title = asString(parsed.value.title);
      if (!title) return { reply: unprocessable('title is required') };
      const labelNames = Array.isArray(parsed.value.labels)
        ? (parsed.value.labels as unknown[]).filter((entry) => typeof entry === 'string')
        : [];
      const labels: Label[] = [];
      for (const labelName of labelNames as string[]) {
        const label = repo.labels.get(labelName);
        if (!label) return { reply: unprocessable(`label ${labelName} does not exist`) };
        labels.push(label);
      }
      const number = store.nextNumber(repo);
      const issue: Issue = {
        id: store.globalId('issue', repo.dbId, number),
        number,
        title,
        body: asString(parsed.value.body) ?? '',
        state: 'open',
        labels,
        comments: [],
        seq: number,
      };
      repo.issues.set(number, issue);
      return { reply: jsonReply(201, issueJson(store, repo, issue)) };
    }
    return { reply: notFound() };
  }
  const number = parseInt(sub[0], 10);
  if (Number.isNaN(number)) return { reply: notFound() };
  const issue = repo.issues.get(number);
  if (!issue) return { reply: notFound() };
  if (sub.length === 1) {
    if (ctx.method === 'GET') return { reply: jsonReply(200, issueJson(store, repo, issue)) };
    if (ctx.method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return { reply: parsed.reply };
      const state = asString(parsed.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = asString(parsed.value.title);
      if (title !== undefined) issue.title = title;
      const body = asString(parsed.value.body);
      if (body !== undefined) issue.body = body;
      return { reply: jsonReply(200, issueJson(store, repo, issue)) };
    }
    return { reply: notFound() };
  }
  if (sub[1] === 'comments') {
    if (ctx.method === 'GET') {
      const comments = issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: store.viewer(), id: 1, type: 'User' },
        created_at: '1970-01-01T00:00:00Z',
      }));
      return { reply: jsonReply(200, comments) };
    }
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return { reply: parsed.reply };
      const body = asString(parsed.value.body);
      if (body === undefined) return { reply: unprocessable('body is required') };
      repo.commentCounter += 1;
      const comment = { id: repo.commentCounter, body, user: store.viewer() };
      issue.comments.push(comment);
      return {
        reply: jsonReply(201, {
          id: comment.id,
          body: comment.body,
          user: { login: store.viewer(), id: 1, type: 'User' },
          created_at: '1970-01-01T00:00:00Z',
        }),
      };
    }
  }
  return { reply: notFound() };
}

// ---------------------------------------------------------------- pulls

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = oldCount.get(line) ?? 0;
    if (count > 0) oldCount.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of oldCount.values()) deletions += count;
  return { additions, deletions };
}

function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headSha, baseSha);
  const baseFlat = base === null ? new Map() : flattenTree(repo, base);
  const headFlat = flattenTree(repo, headSha);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    if (inBase && inHead && inBase.oid === inHead.oid) continue;
    const oldText = inBase ? (repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '') : '';
    const newText = inHead ? (repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = !inBase ? 'added' : !inHead ? 'removed' : 'modified';
    files.push({
      sha: inHead ? inHead.oid : inBase?.oid,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

function handlePulls(ctx: RestCtx, repo: Repo, sub: string[]): { reply: HttpReply; link?: string } {
  const store = ctx.store;
  if (sub.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      const path = `/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
      const paged = pagedJson(ctx, path, pulls.map((pull) => pullJson(store, repo, pull)));
      return { reply: paged.reply, link: paged.link ?? undefined };
    }
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return { reply: parsed.reply };
      const title = asString(parsed.value.title);
      const head = asString(parsed.value.head);
      const base = asString(parsed.value.base);
      if (!title || !head || !base) return { reply: unprocessable('title, head and base are required') };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { reply: unprocessable('head or base branch does not exist') };
      const number = store.nextNumber(repo);
      const pull: Pull = {
        id: store.globalId('pull', repo.dbId, number),
        number,
        title,
        body: asString(parsed.value.body) ?? '',
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
      return { reply: jsonReply(201, pullJson(store, repo, pull)) };
    }
    return { reply: notFound() };
  }
  const number = parseInt(sub[0], 10);
  if (Number.isNaN(number)) return { reply: notFound() };
  const pull = repo.pulls.get(number);
  if (!pull) return { reply: notFound() };
  if (sub.length === 1) {
    if (ctx.method === 'GET') return { reply: jsonReply(200, pullJson(store, repo, pull)) };
    return { reply: notFound() };
  }
  if (sub[1] === 'files' && ctx.method === 'GET') {
    return { reply: jsonReply(200, pullFiles(repo, pull)) };
  }
  if (sub[1] === 'merge' && ctx.method === 'PUT') {
    const result = squashMergePull(repo, pull);
    if (result.status !== 200) return { reply: jsonReply(405, { message: result.message ?? 'merge failed' }) };
    return { reply: jsonReply(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' }) };
  }
  return { reply: notFound() };
}

/** Squash-merge a pull request onto its base branch: the base tip tree with
 *  the head's changes applied, as one commit. Returns 405 on a merge
 *  conflict (a path changed on both sides since the merge-base, to different
 *  contents) or when the pull is already merged. Shared with the GraphQL
 *  mergePullRequest mutation so both surfaces merge the same way. */
export function squashMergePull(repo: Repo, pull: Pull): { status: number; sha?: string; message?: string } {
  if (pull.merged) return { status: 405, message: 'pull request already merged' };
  // The base branch may have moved since the pull request was opened (an
  // earlier merge, for example), so the conflict check reads the branch
  // tips as they are now, not the shas recorded at creation time.
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, headSha, baseSha);
  const baseFlat = base === null ? new Map() : flattenTree(repo, base);
  const headFlat = flattenTree(repo, headSha);
  const baseTipFlat = flattenTree(repo, baseSha);
  const paths = new Set([...headFlat.keys(), ...baseTipFlat.keys()]);
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    const inTip = baseTipFlat.get(path);
    const headChanged = (inHead?.oid ?? null) !== (inBase?.oid ?? null);
    const tipChanged = (inTip?.oid ?? null) !== (inBase?.oid ?? null);
    if (headChanged && tipChanged && (inHead?.oid ?? null) !== (inTip?.oid ?? null)) {
      return { status: 405, message: 'merge conflict' };
    }
  }
  const merged = new Map(baseTipFlat);
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    const headChanged = (inHead?.oid ?? null) !== (inBase?.oid ?? null);
    if (!headChanged) continue;
    if (inHead) merged.set(path, inHead);
    else merged.delete(path);
  }
  const changes = new Map<string, Buffer | null>();
  for (const path of new Set([...merged.keys(), ...baseTipFlat.keys()])) {
    const inMerged = merged.get(path);
    const inTip = baseTipFlat.get(path);
    if ((inMerged?.oid ?? null) === (inTip?.oid ?? null)) continue;
    if (!inMerged) {
      changes.set(path, null);
    } else {
      const blob = repo.objects.get(inMerged.oid);
      changes.set(path, blob ? blob.data : Buffer.alloc(0));
    }
  }
  const message = `${pull.title} (#${pull.number})`;
  const commitOid = commitChanges(repo, pull.base, message, changes);
  if (commitOid === null) return { status: 405, message: 'base branch moved' };
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = '1970-01-01T00:00:00Z';
  pull.mergeCommitSha = commitOid;
  return { status: 200, sha: commitOid };
}
