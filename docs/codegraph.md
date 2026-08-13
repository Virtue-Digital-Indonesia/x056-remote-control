# Code graph service (ops)

Call-graph indexing for this repo, exposed to sessions as the `codegraph` MCP
server. This is the **safe half** of [TencentDB Agent
Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (MIT) — its
MemoryKnowledge component only. The MemoryProxy half is deliberately **not**
deployed: it works by pointing `ANTHROPIC_BASE_URL` at a gateway that rewrites
requests, which would sit directly on top of the rate-limit signals
`src/detector.ts` reads to drive account failover, and its `costGuard` silently
reroutes to a cheaper model. See `docs/research-2026-08-13-memory-and-toolkit.md`.

## Where it runs

| | |
| --- | --- |
| Container | `x056-codegraph` on the **dind sidecar** (not the host, not this container) |
| Image | `x056-codegraph:0.4.0`, built from `Dockerfile.x056` |
| Endpoint | `http://dind:8421` from a session; `/v3` API prefix |
| Source | `/app/state/tools/TencentDB-Agent-Memory/` (sparse checkout, MemoryKnowledge only) |
| Data | docker volume `x056-codegraph-data` |
| Graph id | `cg-t54lyf43` |

Living on dind means gateway deploys don't touch it, and `--restart
unless-stopped` brings it back from a crash (verified: killing the node process
increments `RestartCount` and the service returns healthy with the graph intact).

It holds **no API key and makes no outbound network calls** — code-graph
indexing is pure static analysis. Only wiki ingest needs an LLM, and we don't
use it.

## Local patches

Six changes were needed on top of v0.1.0. They live in the sparse checkout, not
in this repo.

**1. `src/source-fetcher/local-fetcher.ts` (new) — index a local checkout.**
Upstream's fetcher is public-HTTPS-only (`first version only supports public
HTTPS repos`), so a private repo could not be indexed at all. The registry had
already reserved the slot (`// 未来：this.register(new LocalSourceFetcher())`);
this fills it, cloning from the local path so nothing leaves the machine and no
credentials are handed to the service.

Because `code_explore` / `code_node` return source, an unconstrained local
fetcher would be an arbitrary file-read primitive for anything that can reach
port 8421. Two guards, both verified by test:

- **Fails closed** — with no `KNOWLEDGE_LOCAL_ROOTS` set, every local path is
  refused. The capability doesn't exist until granted.
- **Realpath containment** — paths are resolved *before* the check, so symlinks
  and `..` can't escape. A symlink planted inside the workspace pointing at
  `/app/state` (which holds account credentials and OAuth tokens) is rejected:
  `local repo_url is outside the allowed roots: /app/state`.

`KNOWLEDGE_LOCAL_ROOTS` is set to `/home/efran/remote-development` — the
workspace only.

**2. `src/mcp/http-client.ts` + `src/mcp/server.ts` — send the tenant header.**
The stdio bridge sent no `x-tdai-service-id`, so *every* tool call failed with
`x-tdai-service-id header is required`. The bridge predates the API's
multi-tenant fields. Now supplied from `KNOWLEDGE_SERVICE_ID`. Header only —
the query routes are id-only and reject a stray `team_id` with `unexpected
field`.

**3. `Dockerfile.x056` (new).** Upstream's Dockerfile `COPY`s
`docker/entrypoint.sh` and `docker/smoke-test.sh`, neither of which exists in
the v0.1.0 tree, so it cannot build.

**3b. `src/middleware/bearer-auth.ts` (new) — the API had NO authentication.**
`KNOWLEDGE_API_TOKEN` existed only as something the MCP bridge *sends*; nothing
server-side ever checked it. The service hands out repository source and wiki
content to any caller that can reach the port — which on dind includes other
projects' throwaway e2e containers. Now gated on the `/v3` prefix (health stays
open for the container healthcheck), constant-time compare, and it logs loudly
at boot when the token is unset. Token lives at
`/app/state/tools/codegraph-token.txt` (mode 600) and in each account's MCP
server env. Verified: unauthenticated request → `401`.

## Memory wiki (`wiki-h0cbwx1t`)

`scripts/codegraph-sync-memories.mjs` mirrors every project's auto-memory files
into a wiki so any session can search **all** projects' memories, not just its
own. 176 files across 9 projects; re-run the script to refresh (idempotent,
upserts by ref; `--dry-run` to preview, `--prune` to drop pages whose source
file is gone).

It writes pages **directly** rather than using `/wiki/ingest`, because ingest is
the LLM path and memories are already structured markdown. So this needs no API
key and nothing leaves the machine.

**Runs hourly** from the host crontab (`:17`), same `flock` pattern as the
deployer, logging the last run to `/home/efran/x056-memsync.log`:

```
17 * * * * /usr/bin/flock -n /tmp/x056-memsync.lock docker exec x056-remote-control-x056-1 \
  node /home/efran/remote-development/x056-remote-control/scripts/codegraph-sync-memories.mjs
```

It has to run *inside* the gateway container: the memory files live in the
`/app/state` volume and the service is reachable only as `dind:8421`, neither of
which exists from the host. Nothing here ever *writes* memories — it mirrors
what the auto-memory system has already put on disk.

Three more upstream fixes were required to make that work (numbered 4–6 above's three):

**4. Directly-written wikis were invisible.** `status` only reached `ready` via
`runBuild()` (the LLM ingest pipeline), and `pageLs()` returns `[]` for anything
not `ready`. Pages written via `page/write` landed on disk and then could not be
listed or searched — the write returned `200` and silently did nothing useful.
Added `WikiService.markReadyFromDirectWrites()`, a no-op while a real build is
in flight so it cannot race `runBuild()`.

**5. The search index was never registered.** `page/write` called
`wikiMgr.sync()`, which throws `Not found` until the engine is registered — and
only ingest registered it. Now falls back to `wikiMgr.init()`, the same no-LLM
registration the boot-time restore path uses.

**6. Ranking put the wrong project first.** Query terms are OR'd with prefix
wildcards, so plain BM25 let a page repeating one common term beat a page
matching every term — `"obscura demo credentials reset"` returned a ClickUp note
above every obscura page. `ftsSearch` now sorts by count of **distinct** query
terms matched, then BM25. Recall is unchanged (matching-any still returns, just
lower); the failing query now returns obscura pages, and previously-good queries
are unaffected.

Retrieval is lexical, not semantic — embeddings would need an inference
endpoint. Concrete nouns work; paraphrase does not.

> **Note on contents.** The memories include real credentials (e.g. a live demo
> login). They are no more exposed than the source files — same machine, same
> sessions — but that is *why* the API token below is not optional.

## Using it from Claude Desktop / claude.ai

The `codegraph` MCP server is **stdio-only** and talks to `dind:8421`, a hostname
that does not exist outside this container — so an external client cannot use it
directly. Instead the tools are re-exposed through the gateway's own MCP endpoint
(`https://<host>/mcp`), which already speaks Streamable HTTP with OAuth 2.1.

`server/codegraph.ts` + `POST /api/codegraph/call` proxy each query, so:

- **no second public surface** — same endpoint and same OAuth consent as the
  conversation tools;
- **the knowledge-service token never leaves the machine** — the gateway holds it
  and forwards server-side;
- **ids are optional** — the gateway fills in this repo's graph and the memory
  wiki, since nothing exposes a way to discover them.

Tools added: `code_search`, `code_explore`, `code_callers`, `code_callees`,
`code_impact`, `code_node`, `wiki_search`, `wiki_read`. Left out deliberately:
`code_files` / `code_status` (low value remotely) and `wiki_list` / `wiki_graph`
(a 177-entry dump is not useful in a chat) — every extra tool costs context in
every client that connects.

> Worth knowing: this widens what an approved connector can reach. Previously
> `/mcp` exposed conversations; it now also exposes **repository source and all
> memories, including the real credentials some contain**. Same OAuth gate,
> bigger prize behind it. Revoke a connector from the panel if that changes.

Two contract mismatches worth remembering (both cost a live round trip to find,
because a mock accepts anything):

- code queries are registered under **short** names — `/code-graph/callers`, not
  `/code-graph/code_callers`;
- `page/read` takes a **batch** (`refs: string[]`) and 400s on `ref`, and it
  answers `[{ref, content}]` — render the content, not the path.

## Rebuild / redeploy

```bash
cd /app/state/tools/TencentDB-Agent-Memory/MemoryKnowledge
./node_modules/.bin/tsdown                                    # local dist (for the MCP bridge)
docker build -f Dockerfile.x056 -t x056-codegraph:0.4.0 .     # dind image

docker rm -f x056-codegraph
docker run -d --name x056-codegraph --restart unless-stopped -p 8421:8421 \
  -v /home/efran/remote-development:/home/efran/remote-development:ro \
  -v x056-codegraph-data:/app/data \
  -e KNOWLEDGE_LOCAL_ROOTS=/home/efran/remote-development \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://dind:8421/v3 \
  -e KNOWLEDGE_AUTO_SYNC_ENABLED=true \
  -e KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN=10 \
  -e KNOWLEDGE_API_TOKEN="$(cat /app/state/tools/codegraph-token.txt)" \
  x056-codegraph:0.4.0
```

**`PORT` must be forced.** This container exports `PORT=4056` for the gateway and
dotenv does not override real env vars — left alone, the service tries to bind
the gateway's port and dies with `EADDRINUSE`. The image pins `PORT=8421`.

## Index another repo

```bash
curl -s -X POST http://dind:8421/v3/code-graph/create \
  -H 'Content-Type: application/json' -H 'x-tdai-service-id: x056' \
  -H "Authorization: Bearer $(cat /app/state/tools/codegraph-token.txt)" \
  -d '{"team_id":"x056","repo_url":"/home/efran/remote-development/<repo>",
       "branch":"main","repo_name":"<repo>"}'
```

Must be an absolute path inside `/home/efran/remote-development` and a git repo.
Note the id it returns — there is no tool to list graphs, so record it in
`CLAUDE.md` alongside `cg-t54lyf43`.

## Removing it

```bash
docker rm -f x056-codegraph && docker volume rm x056-codegraph-data
```

Then drop the `codegraph` entry from the MCP servers panel. Nothing in the
gateway depends on it. The memory wiki is a mirror — the auto-memory files under
`/app/state/accounts/*/projects/*/memory/` remain the source of truth and are
untouched by any of this.
