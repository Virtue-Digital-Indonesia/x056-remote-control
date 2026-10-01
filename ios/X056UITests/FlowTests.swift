import XCTest

/// Drives the app against the repo's fixture gateway:
///   X056_TEST_PORT=8768 node --import tsx test/browser/fixture.ts
/// It seeds "Website refresh" with three conversations, a pending question on
/// the first, and a fake CLI that answers "Fixture response received.".
final class FlowTests: XCTestCase {
    private let server = ProcessInfo.processInfo.environment["X056_FIXTURE_URL"] ?? "http://127.0.0.1:8768"
    private let token = "browser-fixture-token-0123456789"

    override func setUp() {
        continueAfterFailure = false
    }

    func testSignInBrowseAndSend() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-X056ResetState"]
        addUIInterruptionMonitor(withDescription: "Notifications") { alert in
            let allow = alert.buttons["Allow"]
            guard allow.exists else { return false }
            allow.tap()
            return true
        }
        app.launch()

        // The fixture has no passkey, so the token section opens by itself
        // once the screen has asked the gateway.
        let change = app.buttons["change-server"]
        XCTAssertTrue(change.waitForExistence(timeout: 10))
        change.tap()
        let serverField = app.textFields["server-field"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5))
        // Tap at the trailing edge so the cursor sits after the last character.
        serverField.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        serverField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        serverField.typeText(server)
        app.buttons["change-server"].tap()
        let tokenField = app.secureTextFields["token-field"]
        XCTAssertTrue(tokenField.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Gateway is reachable"].waitForExistence(timeout: 10))
        tokenField.tap()
        tokenField.typeText(token)
        snapshot(app, "1-login")
        app.buttons["token-signin"].tap()

        // The permission alert belongs to SpringBoard; tap Allow directly.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }

        // Home: the fixture's pending question puts its conversation in
        // Needs attention.
        XCTAssertTrue(app.staticTexts["Needs attention"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Build the new homepage"].exists)
        snapshot(app, "2-home")

        // Usage gauges: the fixture has one Claude account limited for an hour.
        app.buttons["Accounts"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Personal workspace"].waitForExistence(timeout: 10))
        snapshot(app, "3-accounts")

        app.buttons["Projects"].firstMatch.tap()
        let project = app.staticTexts["Website refresh"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        snapshot(app, "3-projects")
        project.tap()

        let conversation = app.staticTexts["Build the new homepage"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        snapshot(app, "4-conversations")
        conversation.tap()

        // The fixture's pending question renders with its options.
        XCTAssertTrue(app.staticTexts["Which landing page should we publish?"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Main page"].exists)
        snapshot(app, "5-conversation")

        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Ship the campaign page.")
        app.buttons["send"].tap()

        // Optimistic row first, then the fake CLI's reply over the event stream.
        XCTAssertTrue(app.staticTexts["Ship the campaign page."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Fixture response received."].waitForExistence(timeout: 20))
        // The question is cleared by the new turn.
        XCTAssertFalse(app.staticTexts["Which landing page should we publish?"].exists)
        snapshot(app, "6-reply")

        // Helpers sheet and the agent tree.
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Helpers")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Agent team"].waitForExistence(timeout: 5))
        snapshot(app, "7-helpers")
        app.buttons["Done"].firstMatch.tap()
        app.buttons["Agents"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Main session"].waitForExistence(timeout: 10))
        snapshot(app, "8-agent-tree")
        app.buttons["Done"].firstMatch.tap()
    }

    /// The main screens in dark mode, signed in to the fixture.
    func testScreensInDark() {
        let app = XCUIApplication()
        app.launchArguments = ["-X056Appearance", "dark"]
        app.launch()
        if app.buttons["change-server"].waitForExistence(timeout: 3) {
            app.terminate()
            return XCTFail("run testSignInBrowseAndSend first: this test needs the fixture sign-in it leaves behind")
        }
        XCTAssertTrue(app.staticTexts["Home"].waitForExistence(timeout: 15))
        sleep(1)
        snapshot(app, "dark-home")
        app.buttons["Projects"].firstMatch.tap()
        let project = app.staticTexts["Website refresh"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        snapshot(app, "dark-projects")
        project.tap()
        let conversation = app.staticTexts["Build the new homepage"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        snapshot(app, "dark-conversations")
        conversation.tap()
        // The fixture's seeded transcript (its fake CLI's live replies are
        // never written there).
        let seeded = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "The layout is ready to review")).firstMatch
        XCTAssertTrue(seeded.waitForExistence(timeout: 10))
        sleep(1)
        snapshot(app, "dark-conversation")
    }

    /// The sign-in screen as it first opens, against the real gateway's
    /// public routes (version, passkey availability), in both appearances.
    func testSignInScreenLooks() {
        for (style, name) in [(XCUIDevice.Appearance.light, "light"), (.dark, "dark")] {
            XCUIDevice.shared.appearance = style
            let app = XCUIApplication()
            app.launchArguments = ["-X056ResetState"]
            app.launch()
            XCTAssertTrue(app.buttons["passkey-button"].waitForExistence(timeout: 10))
            _ = app.staticTexts["Gateway is reachable"].waitForExistence(timeout: 10)
            snapshot(app, "signin-\(name)")
            app.buttons["use-token"].firstMatch.tap()
            _ = app.secureTextFields["token-field"].waitForExistence(timeout: 3)
            snapshot(app, "signin-token-\(name)")
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
    }

    private func snapshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
        // On iPhone Duo held open, XCTest captures a blank display. When the
        // host runs a watcher on this folder, ask it for a simctl screenshot.
        let dir = "/tmp/x056-shots"
        guard FileManager.default.fileExists(atPath: dir) else { return }
        let request = "\(dir)/\(name).request"
        FileManager.default.createFile(atPath: request, contents: nil)
        for _ in 0..<30 where FileManager.default.fileExists(atPath: request) { usleep(100_000) }
    }
}
