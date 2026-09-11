# Project spaces: build review

Project now has **Chat, Work, Files, and Memory** on `feature/project-spaces`. The implementation is ready for local review. The feature remains off by default; production still runs `efdd213`.

| Area | What changed |
| --- | --- |
| Project | Shared home with real URLs, separate Chat/Work defaults, activity, costs, and settings. Work requires workspace setup. |
| Files | Shared saved versions, uploads, previews, downloads, and retained Work outputs. Chat and Work can edit selected versions without overwriting competing changes. |
| Memory | Reviewed Project brief and shared decisions. Existing Chat-local memory stays local. Each turn records the memory revisions it used. |
| Handoffs | Continue in Work or discuss in a fresh Chat with an editable brief, source links, and exact saved versions. Retries avoid duplicate conversations/messages. |
| Controls | Provider, model, effort, account, plugins, MCP, and skills remain available. Project requirements respect the actual account and working directory. |

Moving a Chat preserves its identity, history, private files, and drafts. Queued messages stay available but require review after their context changes. Archiving pauses future work; restoring does not resume it automatically.

These screenshots show the implemented Files view using isolated sample data.

![Project Files on desktop](https://x056.think.val.id/project-spaces-desktop-20260911.png)

![Project Files on mobile](https://x056.think.val.id/project-spaces-mobile-20260911.png)

Validation passed: **866 tests, typecheck, four browser workflows, and four document checks**. Browser checks reported no JavaScript errors. The DOCX workflow uses the installed document toolkit to edit, save, and preview versions while retaining original bytes.

Recovery checks cover legacy file catalogs, committed SQLite WAL data, stale checkouts, later writes, and restoration. An older file-store binary cannot read the new schema. The supported first rollback step disables the feature while retaining compatible code and new data.

Provider routing and failover checks use isolated or simulated providers. A real account-limit event and production deployment verification remain pending. No production test conversations or messages were created.

[Acceptance record](https://x056.think.val.id/2026-09-11-project-spaces-build.md) · [Recovery runbook](https://x056.think.val.id/project-spaces-recovery-20260911.md) · [Original plan](https://x056.think.val.id/rc-project-chat-work-memory-plan-20260911.md)
