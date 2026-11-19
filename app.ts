// HTTP front door: reads the whole request body, checks the bearer token on
// every API surface (never on /healthz), routes to the git, REST, GraphQL
// and MCP handlers, and stamps every reply with a request id.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, jsonReply } from './githttp.ts';
import type { HttpReply } from './githttp.ts';
import { handleRest } from './rest.ts';
import type { RestCtx } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

let requestCounter = 0;

function send(res: ServerResponse, reply: HttpReply, extraHeaders?: Record<string, string>): void {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'Content-Type': reply.contentType,
    'Content-Length': String(reply.body.length),
    'X-GitHub-Request-Id': `req-${requestCounter}`,
    ...extraHeaders,
  };
  res.writeHead(reply.status, headers);
  res.end(reply.body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createForgeServer(store: Store, token: string | null): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = req.method ?? 'GET';
        const body = await readBody(req as IncomingMessage);
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
        const segments = url.pathname.split('/').filter((segment) => segment !== '');

        if (method === 'GET' && url.pathname === '/healthz') {
          send(res, jsonReply(200, { ok: true }));
          return;
        }

        // Every API surface takes the same bearer token the env put in the
        // environment. A missing or wrong token is a 401 with a JSON body.
        const needsAuth = url.pathname.startsWith('/api/') || url.pathname === '/mcp';
        if (needsAuth && token !== null) {
          const header = req.headers.authorization ?? '';
          if (header !== `Bearer ${token}`) {
            send(res, jsonReply(401, { message: 'Bad credentials' }));
            return;
          }
        }

        if (url.pathname === '/api/graphql' && method === 'POST') {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            send(res, jsonReply(400, { message: 'request body is not valid JSON' }));
            return;
          }
          const result = executeGraphQL(store, parsed);
          send(res, jsonReply(200, result));
          return;
        }

        if (url.pathname === '/mcp' && method === 'POST') {
          // The bearer check above already answered 401 when the token was
          // missing or wrong; reaching this point means the call is
          // authenticated (or no token is configured at all).
          const reply = handleMcp(store, body, true);
          send(res, { status: reply.status, contentType: 'application/json', body: reply.body });
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          const ctx: RestCtx = {
            store,
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body,
            baseUrl,
          };
          const { reply, link } = handleRest(ctx);
          const extra: Record<string, string> = { 'X-OAuth-Scopes': 'repo, read:org' };
          if (link) extra.Link = link;
          send(res, reply, extra);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const action = gitMatch[3];
          const protocolHeader = req.headers['git-protocol'] ?? '';
          const protocol2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
          if (method === 'GET' && action === 'info/refs') {
            const service = url.searchParams.get('service') ?? '';
            send(res, handleInfoRefs(store, owner, repoName, service, protocol2));
            return;
          }
          if (method === 'POST' && action === 'git-upload-pack') {
            send(res, handleUploadPack(store, owner, repoName, body, protocol2));
            return;
          }
          if (method === 'POST' && action === 'git-receive-pack') {
            send(res, handleReceivePack(store, owner, repoName, body));
            return;
          }
          send(res, jsonReply(404, { message: 'Not Found' }));
          return;
        }

        send(res, jsonReply(404, { message: 'Not Found' }));
      } catch (error) {
        // A handler must never take the server down with it: the suite
        // checks the server is still healthy after a malformed request.
        try {
          send(res, jsonReply(500, { message: error instanceof Error ? error.message : 'internal error' }));
        } catch {
          // The response may already be gone; nothing more to do.
        }
      }
    })();
  });
  return server;
}
