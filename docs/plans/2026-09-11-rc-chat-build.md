# RC Chat build

The core Chat workflow is implemented. Deployment is withheld at Efran's request.

[Screenshots and short review](https://x056.think.val.id/rc-chat-build-review-20260911.md)

Work continues on `feature/rc-chat` in `.deploy/worktrees/rc-chat`.
The shared checkout has the initial implementation at `9656652`. Production still runs `8c0e6ae`.

## Included

| Area | Behavior |
| --- | --- |
| Chat | Create, search, rename, archive, restore, and resume one persistent conversation. |
| Controls | Existing provider, model, effort, account, routing, tools, drafts, queues, and conversation controls. |
| Files | Stream uploads; retain originals; check out edits; save versions; restore earlier versions; remove and restore file references. |
| Documents | Inspect, create, and edit supported DOCX text; convert to PDF and page previews; download exact saved bytes. |
| Recovery | Reject stale edits, keep retry receipts, recover preview jobs, and reuse previews for identical content. |
| Tools | Per-account skills, plugins, MCP readiness, required capabilities, version comparison, and configuration refresh. |
| References | Read project conversations, keep references, and draft messages through existing approval and reply tools. |
| UI | Desktop and mobile Chat layout, file panels, version history, previews, and grouped Chat costs. |

Saved files have read-only permissions. Working copies remain writable.
The runtime retains the document Python environment, LibreOffice, Poppler, and the document skill.

## Verification

- `npm test`: 829 tests passed across 72 files.
- `npm run typecheck`: passed.
- Four document fixture tests passed, including unchanged structures, rendered pages, and refusal of unsafe previews.
- Browser checks passed for Chat, removed files, references, grouped costs, existing composer behavior, and the artifact library.
- The panel boots when the optional Chat script returns 404.
- The full Docker image built successfully. Its document workflow passed without a source-code mount.
- Real Claude and Codex conversations each continued on a second account and saved three document versions.

The live account check found a Codex connector-directory HTTP 403.
Local skills and connected MCP tools remain discoverable. Unverified remote plugins show as installed and cannot satisfy required-tool routing.
This check does not prove every connector is usable.

## Panel incident and isolation

The running gateway served edited HTML from the workspace before its new asset routes existed.
The missing Chat script stopped startup. A guarded initializer restored access; browser verification found no page errors.

Further UI work uses the isolated checkout. Compose now defaults to the panel and assets inside the built image.
The local deployment configuration also points to `/app/server/public/panel.html` for the next approved swap.
The current container retains its original setting until that swap.

Efran briefly authorized deployment, then withdrew authorization after panel access returned.
No deployment request was sent. Do not deploy without renewed authorization.

During the authorized preparation window, registry and retained-file backups were saved under:
`.deploy/backups/rc-chat-20260911T020606Z` in the shared checkout.
The RC nginx upload limit changed from 180 MiB to 201 MiB.
An invalid nginx placeholder named `--help` blocked validation. Its contents were backed up and replaced with a comment.
Nginx validation and reload then passed.

## Rollout and rollback

Merge the reviewed branch only when preparing an approved release.
Keep the image panel path. Back up registry, queue state, artifact index, retained files, and Chat workspaces.
For an existing Chat catalog, use SQLite's backup API while the gateway runs, or copy it after stopping writes.
Include the catalog's WAL when taking a filesystem snapshot.

Enable `X056_CHAT_ENABLED=1` only for the approved rollout.
Verify `.deploy/status.json`, the latest log entry, authenticated Chat endpoints, both asset routes, and a document preview.

Rollback by disabling Chat and swapping to the prior approved image. Retain the catalog, workspaces, and artifacts.
Cross-provider handoff, automatic Desktop import, and full spreadsheet or slide editors remain outside this release.
