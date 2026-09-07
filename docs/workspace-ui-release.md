# Workspace UI release

Built and staged on 7 September 2026. Production assets remain unchanged.

[Review the screens](https://x056.think.val.id/panel-drafts/refinement/workspace/).

## Agent activity and parallel work

The agent pane now uses compact rows, search, status filters, and usage summaries. It initially shows 30 agents, with more available on request.

The agent reader has Conversation, Brief, and Result tabs. Earlier messages load without losing the current reading position. Follow latest resumes automatic scrolling. Workflow agents use the same reader.

One compact indicator replaces the stacked running pills. Its searchable list groups conversations by project. Selecting a row opens that exact conversation, including across projects.

## Codex commands and agents

The composer lists panel commands. `/compact` starts native context compaction. `/review` starts native review, with optional instructions. Skill shortcuts resolve through the account’s enabled project skills. Unknown commands produce an explanation.

`/new`, `/resume`, `/model`, `/status`, `/cost`, and `/agent` open panel actions. `/skills` and `/help` list available commands and skills. CLI commands outside this supported set remain unavailable unless an enabled skill provides them.

A live Codex subagent completed the audit and exchanged messages with its parent. Its rollout exposed inherited completion events and duplicate entries across shared accounts. Both tracking defects are fixed. Native agent activity now appears live and survives history reloads. Existing threads receive updated gateway instructions when resumed.

Native compaction also completed in a separate live app-server check. The implementation follows the [Codex app-server interface](https://learn.chatgpt.com/docs/app-server).

## Project cost estimates

The dashboard now groups recorded usage by project and conversation, including nested subagents. It supports Claude and Codex transcripts. Shared transcript files count once. Codex cumulative usage events no longer multiply token totals, and cached input stays separate.

The display identifies incomplete scans, missing transcripts, and unpriced models. Figures estimate standard API token costs, not subscription charges or future project costs. They exclude tool fees, priority tiers, fast tiers, and long-context premiums. Cache writes use the five-minute rate.

Rates were checked against the [OpenAI model documentation](https://developers.openai.com/api/docs/models) and [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) on 7 September 2026.

## Flexible questions

The ASK protocol accepts any number of choices and questions. Bundled questions submit together, with a custom answer available for each question. Draft answers survive reloads. Failed sends retain the answers and show an error. Replies target their original conversation.

## Recommended management improvements

| Improvement | Intended behavior |
| --- | --- |
| Pinned projects | Keep frequent projects above the full project list. |
| Searchable archive | Remove finished work from daily views while keeping its history searchable. |
| Bulk actions with Undo | Move, archive, or dismiss selected conversations together. |
| Review inbox | Separate completed work awaiting review from questions that require a decision. |

These management improvements are proposals, separate from the implemented changes above.

## Validation

All 632 tests passed, along with TypeScript checking. Browser checks covered desktop and mobile layouts, accounts, settings, command dispatch, and question recovery. Stress checks used 85 agents and 43 running conversations.

The live subagent and compaction checks passed. Public screenshots use fixture data. No gateway deployment or restart was performed.
