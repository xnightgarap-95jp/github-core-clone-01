// Model Context Protocol over Streamable HTTP: JSON-RPC 2.0, plain JSON
// answers. The modern era (server/discover, protocol 2026-07-28) is served
// first; the legacy initialize handshake is answered too, so a client that
// probes discover and falls back still connects. Tools act on the same store
// as REST, so a repository or issue created here reads back identically over
// /api/v3.

import type { Store } from './store.ts';
import { issueJson, pullJson, repoJson, squashMergePull } from './rest.ts';

export interface McpReply {
  status: number;
  body: Buffer;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repositories',
    description: 'List the repositories owned by the viewer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8') };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8') };
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return toolError(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  if (name === 'list_repositories') {
    return toolResult(store.listViewerRepos().map((repo) => repoJson(store, repo)));
  }
  if (name === 'create_repo') {
    const repoName = strArg(args, 'name') as string;
    const owner = strArg(args, 'owner');
    if (owner && store.viewerLogin === null) store.viewerLogin = owner;
    const repo = store.createRepo(
      repoName,
      strArg(args, 'description') ?? '',
      args.private === true,
      owner ?? store.viewer(),
    );
    if (!repo) return toolError(`a repository named ${repoName} already exists`);
    return toolResult(repoJson(store, repo));
  }
  const owner = strArg(args, 'owner') as string;
  const repoName = strArg(args, 'repo') as string;
  const repo = store.resolve(owner, repoName);
  if (!repo) return toolError(`repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') return toolResult(repoJson(store, repo));
  if (name === 'create_issue') {
    const number = store.nextNumber(repo);
    const issue = {
      id: store.globalId('issue', repo.dbId, number),
      number,
      title: strArg(args, 'title') as string,
      body: strArg(args, 'body') ?? '',
      state: 'open' as const,
      labels: [],
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return toolResult(issueJson(store, repo, issue));
  }
  if (name === 'list_issues') {
    const state = strArg(args, 'state') ?? 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    return toolResult(issues.map((issue) => issueJson(store, repo, issue)));
  }
  if (name === 'create_pull_request') {
    const head = strArg(args, 'head') as string;
    const base = strArg(args, 'base') as string;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return toolError('head or base branch does not exist');
    const number = store.nextNumber(repo);
    const pull = {
      id: store.globalId('pull', repo.dbId, number),
      number,
      title: strArg(args, 'title') as string,
      body: strArg(args, 'body') ?? '',
      state: 'open' as const,
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
    return toolResult(pullJson(store, repo, pull));
  }
  if (name === 'merge_pull_request') {
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(pullNumber);
    if (!pull) return toolError(`pull request #${pullNumber} not found`);
    const result = squashMergePull(repo, pull);
    if (result.status !== 200) return toolError(result.message ?? 'merge failed');
    return toolResult(pullJson(store, repo, pull));
  }
  return toolError(`unknown tool ${name}`);
}

export function handleMcp(store: Store, body: Buffer, hasAuth: boolean): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const id = 'id' in record ? record.id : null;
  if (!hasAuth) {
    return rpcError(id ?? null, -32000, 'Unauthorized', 401);
  }
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no JSON-RPC answer.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: Buffer.alloc(0) };
    }
    return rpcError(null, -32601, `Method not found: ${method}`);
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'initialize') {
    const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string'
      ? (params as Record<string, unknown>).protocolVersion as string
      : '2026-07-28';
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) return rpcError(id, -32602, `unknown tool ${toolName}`);
    const result = callTool(store, toolName, args);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
