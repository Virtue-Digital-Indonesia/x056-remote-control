# Remote Control Chat

One task, across accounts. Keep the conversation and working files together.

[Open the interactive UI draft](https://x056.think.val.id/sites/rc-chat-review/)

## First release

| Feature | Behavior |
| --- | --- |
| Free-form chats | Start without a project. Search, rename, pin, and archive chats. |
| Provider controls | Choose provider, model, effort, and account. Remember selections. |
| Account continuity | Resume through another available account of the same provider. Show the switch and retain saved files. |
| Routing choice | Use automatic switching or pin an account. Show waiting status when no eligible account has capacity. |
| Document work | Upload references, create and revise DOCX files, preview output, and download saved versions. |
| Persistent files | Keep each chat’s uploads and outputs together, independent of the active account. |
| Project references | Select project conversations with `@`. Read context and link answers to their sources. |
| Project messaging | Review outgoing messages. Show destination, delivery status, and correlated replies inside Chat. |
| Existing controls | Reuse streaming, tool activity, stop/continue, drafts, queues, notifications, and automations. |

## Later

- Continue with another provider through a linked chat and context handoff.
- Continue in a project with selected messages and files.

## Review this flow

Open the proposal, preview a version, then try **Account limit**. Open **Account** to compare automatic switching with pinning. Use **@ Reference** to add project context and simulate a message exchange.

## Draft boundaries

This is an interactive UI draft with sample data. Messages, account switches, and project interactions are simulated. File selection stays local. DOCX downloads contain sample proposal content.

RC already has account failover, shared session storage, and cross-project tools. This draft proposes a new Chat entry point and document workflow. Interrupted operations may need to run again after a switch.

An existing Desktop task starts here with an uploaded document and relevant conversation context. Automatic Desktop conversation import is outside this first release.
