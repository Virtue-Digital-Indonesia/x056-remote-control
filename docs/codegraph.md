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
| Image | `x056-codegraph:0.1.0`, built from `Dockerfile.x056` |
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

Three changes were needed on top of v0.1.0. They live in the sparse checkout, not
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

## Rebuild / redeploy

```bash
cd /app/state/tools/TencentDB-Agent-Memory/MemoryKnowledge
./node_modules/.bin/tsdown                                    # local dist (for the MCP bridge)
docker build -f Dockerfile.x056 -t x056-codegraph:0.1.0 .     # dind image

docker rm -f x056-codegraph
docker run -d --name x056-codegraph --restart unless-stopped -p 8421:8421 \
  -v /home/efran/remote-development:/home/efran/remote-development:ro \
  -v x056-codegraph-data:/app/data \
  -e KNOWLEDGE_LOCAL_ROOTS=/home/efran/remote-development \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://dind:8421/v3 \
  -e KNOWLEDGE_AUTO_SYNC_ENABLED=true \
  -e KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN=10 \
  x056-codegraph:0.1.0
```

**`PORT` must be forced.** This container exports `PORT=4056` for the gateway and
dotenv does not override real env vars — left alone, the service tries to bind
the gateway's port and dies with `EADDRINUSE`. The image pins `PORT=8421`.

## Index another repo

```bash
curl -s -X POST http://dind:8421/v3/code-graph/create \
  -H 'Content-Type: application/json' -H 'x-tdai-service-id: x056' \
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
gateway depends on it.
