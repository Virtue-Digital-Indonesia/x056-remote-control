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

Unit tests and one UI flow run against the repo's fixture gateway, which has a fake CLI and seeded conversations:

```sh
X056_TEST_PORT=8768 node --import tsx test/browser/fixture.ts &
cd ios && xcodebuild test -project X056.xcodeproj -scheme X056 \
  -destination 'platform=iOS Simulator,name=<simulator>'
```

The UI flow answers the fixture's pending question. Restart the fixture before running it again.

## TestFlight

1. Set `DEVELOPMENT_TEAM` in `project.yml` to the paid team and run `xcodegen generate`. A Personal Team cannot sign the Push capability.
2. Create the app in App Store Connect with bundle ID `id.val.x056`.
3. Archive and upload:

```sh
cd ios
xcodebuild archive -project X056.xcodeproj -scheme X056 -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/X056.xcarchive -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath build/X056.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export -allowProvisioningUpdates
```

`ExportOptions.plist` uploads straight to App Store Connect and bumps the build number when it is already taken.

## Push

The gateway sends nothing until it has an APNs key. Create one in the developer portal (Keys, Apple Push Notifications service), then install it once:

```sh
jq -n --arg keyId <KEY_ID> --arg teamId <TEAM_ID> --arg bundleId id.val.x056 \
  --rawfile key AuthKey_<KEY_ID>.p8 '{keyId:$keyId, teamId:$teamId, bundleId:$bundleId, key:$key}' \
| curl -sS -X POST https://x056.rc.val.id/api/push/apns/config \
  -H "Authorization: Bearer $X056_TOKEN" -H 'Content-Type: application/json' -d @-
```

The gateway writes it to `state/secrets/apns.json` with mode 0600, and no route returns it. Then open Settings in the app and tap **Send a test notification**. It shows what APNs answered for each device.

- A Debug build from Xcode registers as `sandbox`. A TestFlight build registers as `production`. One gateway serves both.
- APNs answers `410` for an uninstalled app and `BadDeviceToken` for a token from the other environment. The gateway drops both, and the app registers again on its next launch.
