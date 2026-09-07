# UI refinement release

The approved refinement is implemented in `design/panel-release/` and staged for release. Production assets remain unchanged. The gateway has not restarted.

[Build screenshots](https://x056.think.val.id/panel-drafts/refinement/build/) show the actual implementation against an isolated gateway. Account identities and limits in these screenshots are fixtures.

## Changes

- Accounts has provider tabs, activity charts, model token charts, and fixed columns for provider limits. Empty periods show an empty state. Additional limits keep their provider labels.
- Account names use provider identity or a saved nickname. Connection IDs appear in advanced details. Nicknames persist through the registry without changing routing keys or usage attribution.
- The account picker shows limits and availability. It separates the next-message choice from switching a running turn. The composer names both accounts when they differ.
- Send and Steer have equal width and height. Conversation actions use a short menu. Activity, notifications, automations, and Settings have separate destinations.
- Settings groups appearance, conversation layout, model defaults, routing, connections, and security. Device appearance has a monitor icon. Large conversation modals have no left navigation rail.

The old account card renderer and global More menu builder are retired. Sign-in, plugins, MCP, passkeys, and prompt templates use their existing handlers inside the new presentation. The conversation menu exposes rename, resume, copy ID, and remove from panel. Removal preserves the transcript on disk.

## Validation

All 616 tests across 47 files pass. TypeScript checks pass. The three browser suites cover:

- Conversation modes, saved preferences, drafts, attachments, scroll position, HTTP/SSE messaging, and account routing.
- A workspace with 32 projects and 605 conversations, question dismissal across tabs, and switching a running account.
- Nickname persistence and validation, charts, limits, picker errors, device appearance, settings, and nested dialogs.

Responsive checks cover widths of 320, 390, 768, and 1440 pixels. Browser runs report no JavaScript errors.

## Release procedure

Deployment requires an explicit user instruction. The previous deployment permission applied to the earlier release.

`server/public/panel.html`, `server/public/control-room.js`, and `server/public/control-room.css` are live assets. Copying files there publishes them immediately. Keep staged files in `design/panel-release/` until deployment is authorized.

After authorization, publish all three staged assets together. Commit the published files and request the gateway deployment through `.deploy/requested`. The backend changes add `POST /api/accounts/label` and return friendly account names.

Verify the deployed commit, static asset hashes, nickname endpoint, and a browser smoke check. The deployment restarts the gateway and can interrupt running tasks.

## Local checks

Start an isolated fixture with `X056_TEST_PANEL` pointing to the staged HTML and `X056_TEST_ASSETS` pointing to `design/panel-release`. Use `X056_TEST_PORT=8767` for `refinement.cjs` and `refinement-details.cjs`.

For `refinement-scale.cjs`, start a fresh fixture with `X056_TEST_MANY=1` and `X056_TEST_PORT=8771`. Each suite accepts the fixture URL as its first argument. The scale suite changes fixture state and needs a fresh fixture for each run.
