#!/usr/bin/env bash
# Archive and upload to TestFlight without a registered device.
#
# Xcode's automatic signing archives with a DEVELOPMENT profile, and that needs
# at least one device on the team. App Store profiles need none. So: archive
# unsigned, ad-hoc sign with the entitlements (that is where aps-environment
# comes from at export), and let -exportArchive re-sign for the App Store.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCHIVE=build/X056.xcarchive
APP=$ARCHIVE/Products/Applications/X056.app

rm -rf "$ARCHIVE" build/export
xcodebuild archive -project X056.xcodeproj -scheme X056 -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath build/dd \
  CODE_SIGNING_ALLOWED=NO
codesign --force --sign - --entitlements X056/Support/X056.entitlements --timestamp=none "$APP"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
