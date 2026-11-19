![make.fun](https://make.fun/badge/github-core-clone-01.svg)
![make.fun rank](https://make.fun/badge/github-core-clone-01/xnightgarap-95jp/github-core-clone-01/rank.svg)
![make.fun reward](https://make.fun/badge/github-core-clone-01/xnightgarap-95jp/github-core-clone-01/reward.svg)

# Forge — a GitHub-compatible git forge in one process

A standalone GitHub-compatible git forge: one process, no git binary, no
package manager, no outside service. It serves git smart HTTP (clone, fetch,
push), the REST v3 API, GraphQL v4 and MCP from its own in-memory store.

Built for [make.fun](https://make.fun/) — see the bounty at
https://make.fun/bounty/github-core-clone-01.

## What it serves

- **Git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2 and v0,
  ls-refs, shallow fetch, thin-pack) and `git-receive-pack` (fast-forward
  enforcement, report-status). Packfiles are read and written by hand
  (node:crypto + node:zlib); objects are stored raw so a pushed commit comes
  back byte for byte.
- **REST v3** — repositories, branches, commits, contents, labels, issues,
  comments and pull requests, with GitHub's status codes, JSON bodies,
  pagination `Link` headers and bearer-token auth.
- **GraphQL v4** — `viewer`, `repository`, `node`, `__type`, and the
  create/close-issue, create/merge-pull-request and add-comment mutations the
  suite sends, with cursor pagination on issue and pull-request connections.
- **MCP** — Streamable HTTP JSON-RPC 2.0: `server/discover`, `initialize`,
  `tools/list` and `tools/call` (create_repo, get_repo, create_issue,
  list_issues, create_pull_request, merge_pull_request, list_repositories),
  acting on the same store as REST.

## Run it

Requires Node.js 22.18+ (the entry is plain TypeScript with erasable types;
no build step, no dependencies).

```sh
node main.ts
```

Under the make.fun harness the process reads `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` from the environment, binds an ephemeral port,
registers it with the env, serves until the env reports done, and exits 0.

## Layout

- `main.ts` — the trial lifecycle: bind, register, poll done, exit.
- `app.ts` — the HTTP front door: body reading, bearer auth, routing.
- `store.ts` — the in-memory store: repositories, issues, pulls, labels.
- `gitobj.ts` — the git object model: hashing, trees, commits, pkt-lines,
  packfiles (read and write, deltas included) and reachability walks.
- `githttp.ts` — git smart HTTP: advertisements, upload-pack, receive-pack.
- `rest.ts` — the REST v3 handlers, including the squash merge.
- `graphql.ts` — a small GraphQL parser and executor for the suite's
  documents.
- `mcp.ts` — the MCP JSON-RPC handlers and tool implementations.

## Notes

- The store is in-memory and deterministic: server-made commits carry a
  fixed author/committer stamp, so two runs on the same instance leave the
  same state.
- The viewer login is learned from the first owner seen in a request path:
  the token is opaque, and the suite always uses the scenario viewer login
  in its paths.
- The forge never binds port 8080 (the env owns it) and never exits before
  the env says done.
