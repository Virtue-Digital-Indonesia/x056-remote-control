**Panel redesign: implementation status**

The working panel now has the approved Control room and Focus layouts. Publication uses the gateway deployer after verification.

**Implemented behavior**

- The Control room groups conversations into In progress, Needs attention, and Finished & idle. Cards use real project, conversation, question, and activity data. Search, project filters, and unread filters narrow the board.
- Display settings save the first-open preference and maximized presentation on this device. Defaults are a side panel and full-page Focus. The large modal has no navigation rail.
- The same conversation engine handles each layout. Messages, streaming, drafts, attachments, model, effort, and reading position survive view changes.
- Accounts shows real identities, provider usage windows, reset times, and stale readings. Controls select the next account, pause future attempts, and configure automatic switching per provider. Existing login, removal, and running-turn controls remain available under Manage.
- Analytics provides daily activity, model token totals, provider/date filters, and CSV export. Collection begins with this release. The dashboard states its coverage.

**Usage coverage**

Historical account attribution was unavailable. The new collector records each attempt against its actual account, including retries and failovers. It excludes earlier history, unfinished attempts, and background work outside a turn. Token totals include only reports received from the main agent. Missing reports stay distinct from measured zero.

Daily aggregates live in `state/account-analytics/`. Reads cover at most 30 daily files. The dashboard does not rescan conversation transcripts. Subscription costs are not inferred from token counts.

**Source map**

| Source | Purpose |
| --- | --- |
| `server/public/panel.html` | Existing conversation engine and presentation bridge |
| `server/public/control-room.js` | Board, display modes, preferences, and account dashboard |
| `server/public/control-room.css` | Neutral theme and responsive layouts |
| `src/account-analytics.ts` | Account attribution and daily aggregates |
| `src/accounts.ts`, `src/failover.ts` | Account eligibility and automatic switching policy |
| `server/manager.ts`, `server/projects.ts` | Integration and persisted conversation outcomes |
| `server/api.controller.ts`, `server/main.ts` | Authenticated endpoints and static assets |

**Verification**

Run `npm run typecheck` and `npm test` before deployment. Backend tests cover account attribution, cache accounting, provider isolation, pause/resume, routing persistence, authentication, and invalid filters.

Browser checks use an isolated gateway with fixture accounts and a fake CLI. Provider quota responses are fixtures; conversation sends and account mutations use real gateway endpoints. Checks cover all four display combinations, reloads, conversation state, account controls, failure states, and widths of 320, 390, 768, and 1440 pixels.

Start `npx tsx test/browser/fixture.ts`, then run `node test/browser/control-room.cjs`. Playwright must be installed locally or available in the gateway image. Screenshots go to `/tmp/x056-control-room-check/`.

**Publication**

The host serves the panel file on every request. Host nginx serves the live CSS and JavaScript. The gateway also exposes both assets. Backend changes require a commit followed by `touch .deploy/requested`. Verify `.deploy/status.json` and the public endpoints after the host swaps the gateway.

The earlier sample-data studies remain under `/panel-drafts/`. Their controls and charts are previews; the working application is at `/`.
