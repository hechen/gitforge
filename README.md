# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hechen/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hechen/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only — no git binary, no package manager, no outside service. It serves git smart HTTP (`/<owner>/<repo>.git`), REST v3 (`/api/v3`), GraphQL v4 (`/api/graphql`) and MCP (`/mcp`) from its own in-memory store, with deterministic, byte-identical state across runs (fixed timestamps, sequential ids, insertion-ordered maps).

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, and exits when the env says the trial is done (see `main.ts`, the lifecycle the harness drives).

---

<sub>Entered on [make.fun](https://make.fun/?ref=hvp8jezm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Layout

- `main.ts` — entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server: routing, auth, request ids, body reading.
- `src/core.ts` — the store, git object model, pack read/write, reachability, tree utilities, global ids.
- `src/gitsmart.ts` — git smart HTTP: info/refs, upload-pack (v0 + v2), receive-pack.
- `src/rest.ts` — GitHub REST v3: repos, branches, commits, contents, labels, issues, comments, pulls, merges.
- `src/graphql.ts` — GitHub GraphQL v4: hand-rolled lexer/parser/executor for the documents the suite sends.
- `src/mcp.ts` — Model Context Protocol over streamable HTTP (JSON-RPC 2.0).

## Auth

Every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. When the variable is set the token must match exactly; otherwise any non-empty token is accepted. `/healthz` takes no auth; `GET /api/v3/` is public.

## Notes

- The token owner is the viewer (`adaiversen`, id 1000); a repository under any other owner answers 404, never 403.
- Packs are version 2, plain objects (no deltas written); OFS/REF deltas are resolved on read.
- Issue and pull-request numbers share one counter per repository.
