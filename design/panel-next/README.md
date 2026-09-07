# Staged panel improvements

These files are ready for review in an isolated gateway. They are not published.
The user requires explicit authorization before deployment because a gateway restart interrupts running tasks.

The project sidebar now has stable colors, search, conversation counts, and activity indicators.
Selecting a project filters the conversation list and sets the destination for new conversations.
The selection survives a reload.

Compact rows replace the overview cards. Questions and running conversations stay visible.
The recent list starts with ten conversations and expands twenty at a time.
Conversation search applies before that limit.

Dismiss clears a pending question without sending a reply, starting a turn, or stopping work.
It works in the overview and conversation. The gateway saves the dismissal and updates other open tabs.
The question timestamp prevents an old dismissal from clearing a newer question.

The composer shows the next account and, during a turn, the account actually running it.
Use next changes the provider's account preference for future attempts across conversations.
Switch this turn resumes the running turn on the chosen account.
The picker keeps Claude and ChatGPT accounts separate.

## Local review

From the repository root, start the fixture:

```sh
X056_TEST_PANEL="$PWD/design/panel-next/panel.html" \
X056_TEST_ASSETS="$PWD/design/panel-next" \
X056_TEST_MANY=1 X056_TEST_PORT=8769 \
./node_modules/.bin/tsx test/browser/fixture.ts
```

Then run `node test/browser/panel-next.cjs http://127.0.0.1:8769`.
The fixture has 32 projects and 605 conversations. It uses fake identities and a fake CLI.
Sends, account changes, switches, and dismissals go through its real gateway endpoints.
Screenshots go to `/tmp/x056-panel-next-check/`.

For the existing browser suite, start a fresh fixture without `X056_TEST_MANY`.
Run `node test/browser/control-room.cjs` with that fixture's URL.
Backend checks are `npm test` and `npm run typecheck`.

Verification passed: 613 tests across 47 files, typechecking, and both browser suites.
Browser coverage includes display modes, conversation state, dismissal across tabs, account switching, and widths from 320 to 1440 pixels.
The `screenshots/` directory contains fixture captures of the sidebar, composer, and account picker.

## Publication after authorization

The three staged UI files replace their namesakes under `server/public/`.
Check `sha256sum -c design/panel-next/BASE.sha256` first and merge any intervening live edits.
Those public files are served directly; copying them publishes the UI.
The dismissal endpoint and running-account snapshot also need the backend deployment.
No deployment request has been created for this change.
