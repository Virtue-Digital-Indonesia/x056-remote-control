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

        let serverField = app.textFields["Server"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 10))
        serverField.tap()
        serverField.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        serverField.typeText(XCUIKeyboardKey.delete.rawValue)
        serverField.typeText(server)
        let tokenField = app.secureTextFields["Token"]
        tokenField.tap()
        tokenField.typeText(token)
        snapshot(app, "1-login")
        app.buttons["Connect"].tap()

        // The permission alert belongs to SpringBoard; tap Allow directly.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }

        let project = app.staticTexts["Website refresh"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        snapshot(app, "2-projects")

        // Usage bars: the fixture has one Claude account limited for an hour.
        app.buttons["Accounts"].tap()
        XCTAssertTrue(app.staticTexts["Accounts"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Personal workspace"].waitForExistence(timeout: 10))
        snapshot(app, "3-accounts")
        app.buttons["Done"].tap()

        project.tap()

        let conversation = app.staticTexts["Build the new homepage"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        snapshot(app, "4-conversations")
        conversation.tap()

        // The fixture's pending question renders with its options.
        XCTAssertTrue(app.staticTexts["Which landing page should we publish?"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Main page"].exists)
        snapshot(app, "5-conversation")

        let composer = app.textViews["composer"].exists ? app.textViews["composer"] : app.textFields["composer"]
        composer.tap()
        composer.typeText("Ship the campaign page.")
        app.buttons["send"].tap()

        // Optimistic row first, then the fake CLI's reply over the event stream.
        XCTAssertTrue(app.staticTexts["Ship the campaign page."].waitForExistence(timeout: 5))
        let reply = app.staticTexts["Fixture response received."]
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        // The question is cleared by the new turn.
        XCTAssertFalse(app.staticTexts["Which landing page should we publish?"].exists)
        snapshot(app, "6-reply")
    }

    private func snapshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
