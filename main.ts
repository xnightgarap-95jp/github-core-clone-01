// Entry point. The trial lifecycle, in the kit's own words:
//
//   1. Start the HTTP server on an ephemeral port: listen(0), then read the
//      port from server.address(). Never bind 8080: the env owns it.
//   2. POST {"port": <the port>} to $MAKEFUN_ENV_URL/register. The first
//      register wins; a later one gets 409.
//   3. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once with {"done": false} while the suite runs, so poll it;
//      never hold a request open and never exit early.
//   4. Exit 0 once it says done.
//
// The server itself lives in app.ts; this file only owns the lifecycle.

import { Store } from './store.ts';
import { createForgeServer } from './app.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  const store = new Store();
  const server = createForgeServer(store, token);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('forge: the server did not bind a port');
    return 1;
  }
  const port = address.port;

  if (envUrl === '') {
    // No env to register with (a local smoke run): stay up until killed.
    console.error(`forge: listening on 127.0.0.1:${port} with no MAKEFUN_ENV_URL set`);
    return 0;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const register = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ port }),
  });
  if (register.status !== 200) {
    console.error(`forge: register answered HTTP ${register.status}`);
    server.close();
    return 1;
  }

  for (;;) {
    const done = await fetch(`${envUrl}/done`, { headers });
    if (done.status === 200) {
      const body = (await done.json()) as { done?: boolean };
      if (body.done === true) break;
    }
    await sleep(250);
  }

  server.close();
  return 0;
}

process.exitCode = await main();
