# x056 for iOS

A native SwiftUI client for the gateway, iOS 18 and later. It uses the same REST and SSE API as the panel. Notifications come from the gateway over APNs (`server/apns.ts`).

## What v1 does

- Projects and chats, with the running (accent) and background (violet) indicators.
- Conversations: history with paging, live replies over the event stream, tool calls folded into one line.
- Composer: text, up to 4 photos (not in Chats), stop, model and effort.
- Pending questions as tap-to-answer buttons, the message queue, and `send_message` approvals.
- Account usage bars.
- Notifications for finished, failed, waiting and interrupted turns, with a Reply action on the notification.

## Build

```sh
brew install xcodegen          # once
cd ios && xcodegen generate    # after adding or removing a Swift file
open X056.xcodeproj
```

`project.yml` is the source of truth. The generated `X056.xcodeproj` is committed, so Xcode opens it without XcodeGen.

## Test

Unit tests and the UI flows run against the repo's fixture gateway, which has a fake CLI and seeded conversations. Start it from the repo root:

```sh
X056_TEST_RICH_REPLY=1 X056_TEST_PORT=8768 node --import tsx test/browser/fixture.ts &
cd ios && xcodebuild test -project X056.xcodeproj -scheme X056 \
  -destination 'platform=iOS Simulator,name=x056 tests'
```

`X056_TEST_RICH_REPLY=1` gives each conversation 120 numbered messages (more than one history page) and makes the fake CLI's reply carry three tool steps, a Markdown table and a two-question batch. `testRichConversation` needs it; the other flows work either way.

Run the UI tests on their own simulator: each one resets the app's sign-in. The flows answer the fixture's pending question, so restart the fixture before running them again.

## TestFlight

The app is on team `Z4NCYN9LKJ` (PT Virtue Digital Indonesia), bundle ID `id.val.x056`. Upload a build with:

```sh
ios/scripts/testflight.sh
```

The script needs no registered device. Xcode's automatic signing archives with a Development profile, and that profile needs a device on the team. So the script archives unsigned, ad-hoc signs the app with its entitlements, and lets the export re-sign it for the App Store. `ExportOptions.plist` uploads straight to App Store Connect. Each run stamps its own build number, `YYYYMMDD.HHMM` in UTC, because App Store Connect rejects a build number it has seen before.

## Passkeys

The app signs in with the same passkeys as the panel, or with the access token. iOS offers `x056.rc.val.id` passkeys to the app only when two things hold:

- The app carries `webcredentials:x056.rc.val.id` in its entitlements (`project.yml`).
- The gateway lists `Z4NCYN9LKJ.id.val.x056` at `/.well-known/apple-app-site-association` (`server/apple-app-site.ts`).

iPhones read that file from Apple's CDN, not from the gateway. Check what the CDN holds with:

```sh
curl -s -D - https://app-site-association.cdn-apple.com/a/v1/x056.rc.val.id
```

The CDN caches a success for up to 6 hours and a failure for 1 hour. An install made while the CDN still holds a 404 does not get passkeys, so ship a build only after the CDN answers 200.

A passkey sign-in gives a 30-day session, the `x056_session` cookie the panel also gets. The app keeps it in the Keychain. When it runs out, the app returns to the sign-in screen.

## Push

The gateway sends nothing until it has an APNs key. Create one in the developer portal (Keys, Apple Push Notifications service), then install it once:

```sh
jq -n --arg keyId <KEY_ID> --arg teamId <TEAM_ID> --arg bundleId id.val.x056 \
  --rawfile key AuthKey_<KEY_ID>.p8 '{keyId:$keyId, teamId:$teamId, bundleId:$bundleId, key:$key}' \
| curl -sS -X POST https://x056.rc.val.id/api/push/apns/config \
  -H "Authorization: Bearer $X056_TOKEN" -H 'Content-Type: application/json' -d @-
```

The gateway writes it to `state/secrets/apns.json` with mode 0600, and no route returns it. Then open Settings in the app and tap **Send a test notification**. It shows what APNs answered for each device.

- Production uses Obscura's key (`8LC7A7XY77`, same team). An APNs key works for every app on its team.
- A Debug build from Xcode registers as `sandbox`. A TestFlight build registers as `production`. One gateway serves both.
- APNs answers `410` for an uninstalled app and `BadDeviceToken` for a token from the other environment. The gateway drops both, and the app registers again on its next launch.
