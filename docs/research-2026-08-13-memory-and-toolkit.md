# Research: TencentDB Agent Memory & everything-claude-code

**Date:** 2026-08-13 · **Evaluated against:** x056-remote-control, Claude Code 2.1.220, Node 22.23.2

Two candidates for the x056 workflow. One is a serious piece of infrastructure with a
dangerous default integration path and a genuinely useful safe subset. The other is a
config bundle that stopped being maintained seven months ago and whose headline feature
is measurably broken on the Claude Code we run.

---

## 1. worldflowai/everything-claude-code

### What it is

A Claude Code **plugin** (marketplace-installable) bundling 9 subagents, 15 slash
commands, 14 skills, 8 rule files, and 12 hook entries. Framing is "battle-tested
configurations from an Anthropic hackathon winner." 1,207 stars, 221 forks.

Installed with:

```
/plugin marketplace add worldflowai/everything-claude-code
/plugin install everything-claude-code@everything-claude-code
```

### The finding that decides it

Its hooks use an **expression matcher syntax** that Claude Code 2.1.220 does not
implement:

```json
"matcher": "tool == \"Bash\" && tool_input.command matches \"(npm run dev|...)\""
```

Every working plugin on this box — including Anthropic's own `claude-security` and
`ralph-loop` — uses a plain regex against the tool name (`"Bash"`, `"*"`, `null`).

**I tested this rather than assuming it.** Scratch config dir, both matcher styles
registered side by side in the same `settings.json`, one real session, one `npm run dev`
tool call:

| Matcher style | Result |
| --- | --- |
| `"Bash"` (plain regex) | **FIRED** |
| `"tool == \"Bash\" && tool_input.command matches ..."` | **did not fire** |
| `"*"` (wildcard, PostToolUse + SessionEnd) | **FIRED** |

The plain-regex control firing in the same run is what makes this conclusive — the
harness works; the expression syntax is simply dead.

**9 of 12 hook entries use the dead syntax.** What that silently kills:

- the tmux enforcement blocks
- the "don't create stray .md files" block
- Prettier auto-format on every JS/TS edit
- `tsc --noEmit` after every `.ts` edit
- console.log warnings, PR-URL logging, compaction suggestions on edit

The 3 surviving `"*"` hooks are SessionStart, PreCompact, SessionEnd, and Stop.

### Two things worth knowing even if the hooks worked

**The memory persistence is a stub.** `session-start.js` only *logs* that recent session
files exist — it does not load them into context. `session-end.js` writes a template
containing the literal string `[Session context goes here]`. There is no extraction. The
README's "memory persistence across sessions" is a filename convention plus a timestamp.

**The dead hooks are, on balance, a reprieve.** The Prettier hook runs
`npx prettier --write` with no project config — on this repo that would reflow the entire
codebase to default 80-column style on the first edit. The `.md` write block would fight
CLAUDE.md's own "upload any .md you create" rule. The tmux block exits 1 unconditionally
when matched, so `npm run dev` would be blocked in a container that has no tmux, breaking
the `/run` + screenshot workflow this project documents.

### Maintenance and licensing

- Created **2026-01-23**, last pushed **2026-01-23**. One day of activity, nothing since.
- 6 open issues, none addressed.
- **No LICENSE file**, despite the README and `marketplace.json` both claiming MIT.
  Default copyright therefore applies. Low practical risk for private use; not something
  to vendor into a repo.
- `marketplace.json` still points `homepage`/`repository` at `affaan-m/everything-claude-code`,
  which 404s. Owner email is `affaan@example.com`.

### Fit for x056

Poor, and largely redundant:

| It ships | We already have |
| --- | --- |
| `code-reviewer` agent, `/code-review` | Anthropic's official `code-review` plugin (installed, enabled) — **command name collides** |
| `security-reviewer` agent, `security-review` skill | `claude-security` plugin (installed, enabled, actively maintained) |
| memory-persistence hooks | x056's own `MEMORY.md` + `memory/` system, actually injected each session |
| `strategic-compact` | Claude Code compacts automatically |
| tmux-centric rules | No tmux; headless container |
| `mcp-configs/*.json` | The MCP servers UI built last week |

**Verdict: don't install.** The parts that are alive duplicate better-maintained things
we already run; the parts that are unique are dead. If anything here appeals, the honest
move is to read `rules/` and `agents/` as *prose* and lift the two or three ideas you
like into our own CLAUDE.md — a 20-minute read, no dependency, no collisions.

---

## 2. TencentCloud/TencentDB-Agent-Memory

### What it is

A team-scale memory platform for AI agents. 20,789 stars, 1,880 forks, **MIT** (GitHub
shows NOASSERTION only because of a Tencent preamble above the standard text). v2.0.0
released 2026-08-03, commits within the last two days. TypeScript, ~34 MB.

Four components:

- **MemoryCore** — the memory engine. Layered pyramid: L0 raw conversations → L1 atomic
  facts (extracted every ~5 turns) → L2 scenario blocks (markdown) → L3 `persona.md`
  (regenerated every ~50 memories). Plus "symbolic memory": task state compressed into
  Mermaid diagrams, with full tool output offloaded to `refs/*.md` and referenced by
  `node_id`. Local SQLite + `sqlite-vec` by default; Tencent Cloud Vector DB optional.
- **MemoryKnowledge** — LLM-Wiki and Code-Graph. **Ships its own MCP server** with
  `code_search`, `code_explore`, `code_callers`, `code_callees`, `code_impact`,
  `code_node`, `code_status`, `code_files`.
- **MemoryProxy** — an LLM gateway. Auth → session init → inject skill/memory/wiki into
  the system prompt → forward upstream → meter usage.
- **MemoryPanel** — web UI.

### Integration path A: MemoryProxy — do not do this here

`MemoryProxy/scripts/setup-claude-code.sh` works by writing into `settings.json`:

```
env.ANTHROPIC_BASE_URL      = https://proxy.xxx/claude-code
env.ANTHROPIC_CUSTOM_HEADERS = X-Tdai-User-Token: tdai_xxx
```

That puts a gateway **inside the request path between Claude Code and Anthropic**. To be
fair: you self-host it, so your traffic isn't going to Tencent. The problems are
structural, not trust:

1. **We authenticate with Claude Max OAuth, not API keys.** The proxy's model is
   `Authorization: Bearer <apiKey>` against an OpenAI/Anthropic-compatible upstream. It
   does support passing the client's original key through, so this *might* work — but
   it's unverified, and the failure mode is our accounts.
2. **It sits exactly where failover lives.** `src/detector.ts` classifies rate-limit vs.
   529-overload by reading the response stream. Anything that normalizes or rewrites
   errors in between corrupts the signal the whole account-switching design rests on.
3. **`costGuard` silently reroutes to a cheaper model** as a fallback. That would make the
   per-conversation model tracking and the limit indicators report something untrue.
4. It applies per config dir — we'd need it replicated across `/app/state/accounts/{a,c}`,
   same as the plugin/MCP managers already do.
5. The Claude Code adapter is explicitly built from **reverse-engineering** CC internals
   (`forkedAgent.ts`, `sideQuery.ts`, plus packet capture, per its own header comment).
   That breaks on Claude Code updates, and Claude Code updates often.

Its native targets are **OpenClaw** and **Hermes**, not Claude Code. Claude Code support
is a bolt-on.

### Integration path B: MemoryKnowledge over MCP — this one is interesting

The code-graph MCP server needs no proxy, no `ANTHROPIC_BASE_URL`, no interception. It's
an ordinary MCP server, and we now have a UI that installs those across every account.

Real value it would add that we don't have: `code_callers` / `code_callees` /
`code_impact` are graph queries, not text search. "What breaks if I change
`deliverMcpMessage`" is currently a ripgrep-and-read exercise.

Caveats, verified:

- **Not published to npm.** Only `@tencentdb-agent-memory/memory-tencentdb` (the OpenClaw
  plugin) is on the registry. `knowledge-service` is **v0.1.0, source-only** — build from
  the repo.
- Needs Node ≥22 (we have 22.23.2 ✓), `better-sqlite3` (native build), and an LLM API key
  for indexing.
- The repo's **default branch is `feat/server_team`** — a feature branch, not `main`. The
  `main` README is behind. That's a repo-hygiene smell worth weighing.
- Documentation is substantially Chinese-first.

---

## Recommendation

**everything-claude-code — skip.** Stale, unlicensed, redundant with two maintained
plugins we already run, and its headline hooks are provably inert on our version.

**TencentDB Agent Memory — take the MCP half, refuse the proxy half.** Never point
`ANTHROPIC_BASE_URL` at anything while multi-account failover is the core of this system.
But MemoryKnowledge's code-graph server is a clean, contained experiment: build it, add
it through the MCP servers UI on one account, point it at this repo, and see whether
`code_impact` actually beats ripgrep. If it does, roll it to all accounts; if not, remove
it — one API call, nothing else touched.

The pitch that made this repo popular is the *memory* layer, and that's precisely the part
that requires the proxy. Worth being clear-eyed: taking the safe subset means **not**
getting the thing it's famous for.

If persistent memory is the actual goal, the cheaper path is extending what we already
have — the `memory/` + `MEMORY.md` system is already injected every session and already
survives compaction. Adding L1/L2 extraction to it is a smaller, safer project than
adopting a gateway.
