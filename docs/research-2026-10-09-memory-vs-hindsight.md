# X056 memory vs Hindsight (vectorize-io)

*2026-10-09. X056 facts are from the code and the live store (`/app/state/memory.sqlite`, read-only). Hindsight facts are from its repo, docs and paper (arXiv 2512.12818), as of v0.10.3 (2026-10-08).*

## Bottom line

- **They solve different halves of memory.** X056 is a *governed note store*: few notes, each reviewed, owned, revisioned and tied to a hashed source. Hindsight is a *learning engine*: it reads every conversation, extracts facts, entities and time with an LLM, and finds them again by meaning, keyword, entity graph and date.
- **Our biggest gap is the intake, not the store.** 6,547 conversation turns are captured as sources, but nothing turns them into notes. Of the 251 confirmed notes, 211 came in through the operator or panel and only 40 from agents. Retrieval is word overlap only (SQLite FTS5 BM25), so a paraphrase misses.
- **Hindsight's biggest gaps for us:**
  - Isolation is per bank only. Finer access control is an open request (#2235).
  - It has no human review step; only automated filters stand between extraction and recall.
  - Every retain sends the text to an LLM.
  - It is still 0.x, with weekly releases.
  - It needs Postgres and a 1.5-2 GB service.
- **Recommendation: borrow, don't replace.** Our review gate, ownership rules and source staleness checks are exactly what Hindsight lacks. Add its two strongest ideas to our store instead: LLM extraction of *proposals* from captured turns, and hybrid retrieval.

## Side by side

| | X056 memory store | Hindsight |
|---|---|---|
| **Unit of memory** | A note: fact / decision / preference / context. Title, content, tags, sources | Extracted facts (world / experience), entities, links, observations, mental models |
| **How it gets in** | An agent calls `memory_propose`, the operator writes in the panel, or legacy files are imported by hand. **No automatic extraction.** | `retain`: an LLM extracts facts, entities, time and links from any text. The Claude Code plugin retains automatically on `Stop` |
| **Review** | Proposed → confirmed. Three modes: manual, auto-confirm own conversation notes, full auto-manage (ours: full auto on) | No human review step found in the docs or API. A fact is recallable once its retain job completes. "Memory Defense" can automatically quarantine writes that match detectors (prompt injection, sensitive data) |
| **Correction** | Revisions kept forever, recoverable trash, optimistic revision checks, merge + superseded, all in the panel | Per-fact history, and a reversible "invalidate" with a reason (`PATCH .../memories/{id}`), API only. Per-fact hard delete is unclear in the current spec (#3509 still open) |
| **Retrieval** | FTS5 BM25 + a JS re-score (term matches, pinned, same project, 90-day recency bonus) | 4 parallel strategies (vector, BM25, entity graph, temporal) → RRF fusion → cross-encoder rerank |
| **Time** | `createdAt` / `updatedAt`, optional TTL (set on 0 notes) | When the event happened *and* when it was learned. Queries like "last March" are parsed |
| **Entities / graph** | None. `memory_links` exists but has **0 rows** and is not used in retrieval | Fuzzy entity resolution ("Alice C." = "Alice Chen"). Entity, temporal, semantic and causal links, all used in recall |
| **Consolidation** | Manual merge only | Background worker turns facts into observations. Mental models refresh themselves. `reflect` is an agentic loop of up to 10 steps |
| **Provenance** | Each note cites hashed, versioned sources. **A changed source pulls the note out of context** until reviewed | Reflect returns a `based_on` citation list. Observations carry evidence |
| **Access control** | Scopes conversation / project / space / shared / global. Agents write only what they own; grants are read-only; providers are filtered per note | Per-bank isolation, optional API key. No per-memory or per-team ACL yet |
| **Into the turn** | A `[Shared memory reference]` block: the message is the search query. Pinned notes and preferences always go in. 24 notes / 4,800 tokens max, and every turn's choice is logged with skip reasons | Claude Code plugin: `UserPromptSubmit` hook auto-recalls and injects. Also MCP tools (27-30) |
| **Providers** | One store for Claude and Codex, with a per-provider gate | Any harness via MCP / SDK. Claude Code and Codex plugins exist |
| **Infra** | One SQLite file (76.5 MB) inside the gateway. No model calls | Postgres + pgvector, API server, workers, UI. Local embedding and rerank models (1.5-2 GB image) plus an external LLM for retain and reflect |
| **Cost per write** | Zero | One LLM extraction call (needs a model with ≥65k output tokens) |
| **Maturity** | Ours: 11 test files; runs in production here | MIT, about 47.5k stars, ~288 contributors, 0.x with weekly releases |
| **Benchmarks** | None | LongMemEval 83.6-91.4%, LoCoMo 83-90% (paper). Later claim of 94.6% without a stated setup. "Independent" reproduction was by the paper's co-authors |

## What Hindsight does that we don't, ranked by value to us

1. **Automatic extraction from conversations.** Our 6,547 captured turns sit unused. Hindsight would have distilled them.
2. **Meaning-based retrieval.** Vectors plus BM25, fused and reranked. Ours misses any note that uses different words than the message.
3. **Agent search over past conversations.** Ours has none: `memory_source_search` reaches only uploaded documents, not the captured turns.
4. **Time as data.** "When did we decide X" and "what was true before the migration" are unanswerable in ours.
5. **Entities and a used link graph.** Ours has the table and nothing in it.
6. **Consolidation / reflect.** Summaries that update themselves as facts arrive.

## What we have that Hindsight doesn't

1. **A review gate**, with staged automation and an operator who can see and undo everything.
2. **Ownership-based write rules**, with read-only grants and no audience widening without review.
3. **Source staleness checks.** A note whose source changed is withheld, not served stale.
4. **Revision history, trash and restore in the panel.** Hindsight has per-fact history and a reversible invalidate, but only through the API.
5. **Zero marginal cost and zero data egress.** Nothing leaves the box to be remembered.
6. **A per-turn injection log**, which shows what each turn was told and why the rest was skipped.

## Options

| Option | Effort | What you get | Risk |
|---|---|---|---|
| **A. Quick wins in our store** | ~1 day | An agent tool over captured conversation sources (`source_fts` already exists, the panel already uses it). Fix the wiki mirror. Fill `memory_links` from merges and supersedes | Low |
| **B. Extraction into proposals** | ~3-5 days | A background job reads new conversation sources and proposes facts and decisions *through the existing review gate*. Haiku 5.5 is the natural model: fast, 1M context. The gateway runs on Max subscriptions, not an API key, so the real cost is account usage limits, not the $0.10/M list price | Medium: proposal noise (dedup and review mitigate it), plus usage taken from the same accounts the conversations need |
| **C. Hybrid retrieval** | ~3-5 days | Embeddings in SQLite (e.g. sqlite-vec), fused with BM25 by RRF. Optionally a small reranker | Medium: an embedding model to host or call |
| **D. Run Hindsight beside the store** | ~1 week to wire, ongoing ops | Hindsight as the recall engine, fed from our sources. Our store stays the governed layer | Postgres, a second service and an LLM bill per retain, all on 0.x churn. Two memories to reconcile. Its Claude Code plugin retains on the `Stop` hook, and under `claude -p` the final reply is not in the transcript yet when `Stop` fires (seen here with the writing-style hook). Hooks are per account, so it must be merged into every account. Codex needs its own integration. Feeding it from the gateway's sources avoids the hooks |
| **E. Replace with Hindsight** | Weeks | Its full feature set | Loses review, ownership, staleness and revisions. **Not recommended** |

**Suggested order:** A, then B, then C. That gets most of Hindsight's value (intake + recall) while keeping our governance. Revisit D only if B and C fall short on recall quality.

## Found along the way

- **The wiki mirror is syncing nothing.** `scripts/codegraph-sync-memories.mjs` reads account `a` by default, which has no `projects/` directory in this container. The hourly job logs "found 0 memory files across 0 projects" (last run 18:17 WIB). The wiki still holds 343 pages from earlier syncs, so `wiki_search` serves a frozen copy that gets no new memories.
- **Most auto-memory never reached the store.** Only 7 of 345 Claude auto-memory files have been imported (import is manual, `POST /api/memory/ingest`).
- **Docs drift.** `docs/codegraph.md` and `server/memories.ts` still describe the file-writing `save_memory`. It now writes a source plus a proposal into the store.

## Sources

- Hindsight repo: https://github.com/vectorize-io/hindsight
- Docs: https://hindsight.vectorize.io/ (retain, retrieval, reflect, models, mcp-server, memory-banks, Claude Code integration pages)
- Paper: https://arxiv.org/abs/2512.12818
- Releases: https://api.github.com/repos/vectorize-io/hindsight/releases
- Third-party review (dated, around v0.8.1): https://rywalker.com/research/hindsight
- X056 code: `server/memory-store.ts` (schema :182-192, search :155-168 and :586-613, context :840-943), `server/memory-documents.ts:158`, `server/manager.ts:3417-3420` and `:3632-3657`, `scripts/x056-mcp-tools.mjs:441-520`
