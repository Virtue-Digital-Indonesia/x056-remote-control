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
        let app = signInToFixture()

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
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Model and effort")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Effort"].waitForExistence(timeout: 5))
        snapshot(app, "7-model-effort")
        app.buttons["Done"].firstMatch.tap()
        app.buttons["Agents"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Main session")).firstMatch.waitForExistence(timeout: 10))
        snapshot(app, "8-agent-tree")
        app.buttons["Done"].firstMatch.tap()
    }

    /// Fresh launch, sign in to the fixture gateway with its token. Never
    /// relies on a sign-in left in the simulator: that may be a real one.
    @discardableResult
    private func signInToFixture(_ extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-X056ResetState"] + extraArguments
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
        // Now and then the reset does not hold and the app opens signed in
        // (cause not found; DEBUG-only path). Sign out the normal way.
        if !change.waitForExistence(timeout: 10), app.buttons["Projects"].exists {
            app.buttons["Projects"].firstMatch.tap()
            app.buttons["Settings"].firstMatch.tap()
            let signOut = app.buttons["Sign out"].firstMatch
            for _ in 0..<4 where !signOut.isHittable { app.swipeUp() }
            signOut.tap()
            app.buttons.matching(NSPredicate(format: "label == %@", "Sign out")).element(boundBy: 1).tap()
        }
        if !change.waitForExistence(timeout: 10) { snapshot(app, "0-signin-missing") }
        XCTAssertTrue(change.exists)
        change.tap()
        let serverField = app.textFields["server-field"]
        XCTAssertTrue(serverField.waitForExistence(timeout: 5))
        // Tap at the trailing edge so the cursor sits after the last character.
        serverField.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        serverField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
        // Return submits the address, the same as Done.
        serverField.typeText(server + "\n")
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
        return app
    }

    /// The main screens in dark mode, signed in to the fixture.
    func testScreensInDark() {
        let app = signInToFixture(["-X056Appearance", "dark"])
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

    /// A long conversation and a rich reply, as the fixture serves them with
    /// X056_TEST_RICH_REPLY=1: earlier messages load without moving what you
    /// read, a step list drops below its header, a table renders, a question
    /// batch wraps and takes written answers, sending follows to the end,
    /// and scrolling back folds the composer away until Latest.
    func testRichConversation() throws {
        let app = signInToFixture()
        app.buttons["Projects"].firstMatch.tap()
        let project = app.staticTexts["Website refresh"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        let conversation = app.staticTexts["Review accessibility findings"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        conversation.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Search"].isHittable, "no tabs or Search in a conversation")
        let projects = try XCTUnwrap(api("GET", "/api/projects")?["projects"] as? [[String: Any]])
        let site = try XCTUnwrap(projects.first { ($0["name"] as? String) == "Website refresh" })
        let conv = try XCTUnwrap((site["conversations"] as? [[String: Any]])?.first { ($0["title"] as? String) == "Review accessibility findings" })
        // A question left by an earlier run would sit over the conversation.
        for q in apiList("/api/questions") where q["sessionId"] as? String == conv["sessionId"] as? String {
            _ = api("POST", "/api/questions/dismiss", ["projectId": site["id"]!, "sessionId": conv["sessionId"]!, "at": q["at"]!])
        }

        // Earlier messages load above without moving what is on screen.
        let earlier = app.buttons["Show earlier messages"]
        for _ in 0..<25 where !(earlier.exists && earlier.isHittable) { app.swipeDown() }
        // One more, so the button sits below the top bar (a tap up there
        // is a tap on the status bar, which scrolls to the top), then let
        // the swipes coast to a stop before measuring.
        app.swipeDown()
        sleep(2)
        XCTAssertTrue(earlier.isHittable)
        XCTAssertGreaterThan(earlier.frame.minY, app.navigationBars.firstMatch.frame.maxY)
        let oldest = app.staticTexts.containing(NSPredicate(format: "label ENDSWITH %@", "(#40)")).firstMatch
        XCTAssertTrue(oldest.exists)
        let before = oldest.frame.minY
        earlier.tap()
        sleep(2)
        snapshot(app, "10-earlier-loaded")
        XCTAssertEqual(oldest.frame.minY, before, accuracy: 2, "loading earlier messages must not move the screen")
        app.swipeDown()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label ENDSWITH %@", "(#39)")).firstMatch.waitForExistence(timeout: 5), "the earlier messages are above")

        // Scrolling back folded the composer; Latest returns to the end.
        let latest = app.buttons["Latest"]
        // Folded: Latest and Write stand in for it. (XCUITest still reports
        // the folded UIKit text view as hittable, so it is not asked.)
        XCTAssertTrue(latest.exists)
        XCTAssertTrue(app.buttons["Write"].isHittable)
        latest.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: latest)
        wait(for: [gone], timeout: 5)
        XCTAssertTrue(composer.isHittable)

        // A turn from "the web" (no keyboard): steps, a table, two questions.
        _ = api("POST", "/api/sessions/current/messages", ["prompt": "Run the checks.", "projectId": site["id"]!, "sessionId": conv["sessionId"]!])
        XCTAssertTrue(app.staticTexts["Fixture response received."].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Public specimen lookup"].waitForExistence(timeout: 5), "the table renders as cells")
        XCTAssertTrue(app.staticTexts["What I need from you"].exists)
        sleep(1)

        // The question card fills the bottom of a phone: it folds to its
        // header, and reading back folds it away with the composer.
        XCTAssertTrue(app.staticTexts["2 questions"].waitForExistence(timeout: 10))
        app.buttons["Hide questions"].tap()
        XCTAssertTrue(app.buttons["Show questions"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Send answers"].exists)
        app.swipeDown(velocity: .slow)
        sleep(1)
        XCTAssertTrue(app.buttons["Write"].waitForExistence(timeout: 5))

        // The step list drops down below its header.
        let steps = app.buttons["steps"].firstMatch
        XCTAssertTrue(steps.waitForExistence(timeout: 10))
        // Into view (an element tap scrolls to it, and opens it), closed
        // again in place, then dragged a third of the way down the screen.
        steps.tap()
        sleep(1)
        steps.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
        sleep(1)
        steps.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
            .press(forDuration: 0.3, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)), withVelocity: .slow, thenHoldForDuration: 0.3)
        sleep(1)
        XCTAssertTrue(steps.isHittable, "steps header at \(steps.frame)")
        let header = steps.frame
        steps.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
        let firstStep = app.staticTexts["Reading home.tsx"].firstMatch
        XCTAssertTrue(firstStep.waitForExistence(timeout: 5))
        sleep(1)
        snapshot(app, "11-steps-open")
        XCTAssertGreaterThanOrEqual(firstStep.frame.minY, steps.frame.maxY, "steps sit below their header")
        XCTAssertEqual(steps.frame.minY, header.minY, accuracy: 1, "opening a step list must not move its header")

        // The question batch: options wrap inside the card, and each
        // question takes a written answer.
        latest.tap()
        XCTAssertTrue(app.buttons["Show questions"].waitForExistence(timeout: 5))
        app.buttons["Show questions"].tap()
        XCTAssertTrue(app.buttons["Send answers"].waitForExistence(timeout: 5))
        // Typing a message folds the card, so the box and send stay on screen.
        composer.tap()
        let folded = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Send answers"])
        wait(for: [folded], timeout: 5)
        XCTAssertTrue(app.buttons["send"].isHittable)
        snapshot(app, "12a-typing-folds-questions")
        app.buttons["Show questions"].tap()
        XCTAssertTrue(app.buttons["Send answers"].waitForExistence(timeout: 5))
        sleep(1)
        let screen = app.windows.firstMatch.frame
        for label in ["Keep the hold until the source owner confirms", "Require verified templates before the demo"] {
            let option = app.buttons[label]
            XCTAssertTrue(option.exists, label)
            XCTAssertLessThanOrEqual(option.frame.maxX, screen.maxX - 8, "\(label) runs past the card")
        }
        snapshot(app, "12-questions")
        let send = app.buttons["Send answers"]
        XCTAssertFalse(send.isEnabled)
        let own = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Your answer: May I lift")).firstMatch
        XCTAssertTrue(own.exists)
        own.tap()
        own.typeText("Only the catalogue checks")
        sleep(1) // the keyboard settles; a tap during its rise misses
        app.buttons["Accept summaries for the demo"].tap()
        let ready = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send)
        wait(for: [ready], timeout: 5)
        send.tap()

        // Sending follows to the end: the answer is on screen, no Latest.
        let answer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Answer: Only the catalogue checks")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertTrue(answer.isHittable, "the sent answer is in view")
        XCTAssertFalse(latest.exists)
        snapshot(app, "13-answer-sent")
    }

    /// Autopilot from the conversation menu (start, the bar, stop), the
    /// transcript, and this iPhone's notification settings.
    func testAutopilotTranscriptAndNotifications() throws {
        let app = signInToFixture(["-X056PushToken", "f00dfeed"])
        app.buttons["Projects"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Website refresh"].waitForExistence(timeout: 10))
        snapshot(app, "20-projects")
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Signed in with"].waitForExistence(timeout: 10))
        sleep(1)
        app.swipeUp()
        // This iPhone's settings, saved to the gateway as they change.
        let automation = app.switches.matching(NSPredicate(format: "label == %@", "Automation and background")).firstMatch
        for _ in 0..<3 where !automation.waitForExistence(timeout: 3) { app.swipeUp() }
        if !automation.exists { snapshot(app, "21-settings-missing") }
        XCTAssertTrue(automation.exists)
        let endpoint = "/api/push/settings?endpoint=apns:f00dfeed"
        let before = api("GET", endpoint)?["automation"] as? Bool ?? false
        // The switch end of the row: a tap on the label does not toggle.
        automation.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let flipped = expectation(description: "saved")
        DispatchQueue.global().async {
            for _ in 0..<20 {
                if (self.api("GET", endpoint)?["automation"] as? Bool) == !before { flipped.fulfill(); return }
                usleep(250_000)
            }
        }
        wait(for: [flipped], timeout: 8)
        let quiet = app.switches.matching(NSPredicate(format: "label == %@", "Quiet hours")).firstMatch
        if !quiet.isHittable { app.swipeUp() }
        if (api("GET", endpoint)?["quietHours"] as? [String: Any])?["enabled"] as? Bool != true {
            quiet.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        }
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "From")).firstMatch.waitForExistence(timeout: 5), "quiet hours show their times")
        sleep(1)
        snapshot(app, "21-notification-settings")
        app.swipeDown()
        app.buttons["Done"].firstMatch.tap()

        app.staticTexts["Website refresh"].tap()
        let conversation = app.staticTexts["Update the component library"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        conversation.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 10))
        let projects = try XCTUnwrap(api("GET", "/api/projects")?["projects"] as? [[String: Any]])
        let site = try XCTUnwrap(projects.first { ($0["name"] as? String) == "Website refresh" })
        let conv = try XCTUnwrap((site["conversations"] as? [[String: Any]])?.first { ($0["title"] as? String) == "Update the component library" })
        // An autopilot an earlier run left armed would change the menu.
        _ = api("POST", "/api/autopilot/stop", ["sessionId": conv["sessionId"]!])
        _ = site

        // Autopilot: start from the menu, the bar shows it, stop from the bar.
        app.buttons["More"].firstMatch.tap()
        app.buttons["Autopilot…"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Keep this conversation going"].waitForExistence(timeout: 5))
        app.buttons["5"].firstMatch.tap()
        // The plan suggestion selects its placeholder path to type over.
        app.buttons["Plan doc"].firstMatch.tap()
        app.typeText("docs/ios-plan.md")
        snapshot(app, "22-autopilot-sheet")
        XCTAssertFalse(app.buttons["Start autopilot"].exists, "the buttons step aside while typing")
        app.buttons["Hide keyboard"].firstMatch.tap()
        app.buttons["Start autopilot"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "steps left")).firstMatch.waitForExistence(timeout: 5))
        let sid = try XCTUnwrap(conv["sessionId"] as? String)
        let mine = { (self.api("GET", "/api/autopilot") ?? [:])[sid] as? [String: Any] }
        // Contains: the sheet prefills what the last run used (/last).
        XCTAssertTrue((mine()?["instruction"] as? String)?.contains("Follow the implementation plan in docs/ios-plan.md and tick off each item as you finish it.") == true, "\(mine() ?? [:])")
        XCTAssertEqual(mine()?["count"] as? Int, 5)
        // Edited while it runs: the budget is untouched.
        app.textViews["Standing instruction"].tap()
        app.typeText(" Run the tests too.")
        app.buttons["Hide keyboard"].firstMatch.tap()
        app.buttons["Save instruction"].firstMatch.tap()
        let saved = expectation(description: "instruction saved")
        DispatchQueue.global().async {
            for _ in 0..<20 {
                if (mine()?["instruction"] as? String)?.contains("Run the tests too.") == true { saved.fulfill(); return }
                usleep(250_000)
            }
        }
        wait(for: [saved], timeout: 8)
        snapshot(app, "23-autopilot-running")
        app.buttons["Done"].firstMatch.tap()
        let bar = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Autopilot")).firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        snapshot(app, "24-autopilot-bar")
        app.buttons["Stop"].firstMatch.tap()
        let stopped = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: bar)
        wait(for: [stopped], timeout: 10)

        // The transcript: CLI lines from the conversation's own file.
        app.buttons["More"].firstMatch.tap()
        app.buttons["Transcript"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Please improve the layout")).firstMatch.waitForExistence(timeout: 10))
        sleep(1)
        snapshot(app, "25-transcript")
        app.buttons["Done"].firstMatch.tap()
    }

    /// Sending from the phone puts the turn on the Lock Screen: the menu
    /// offers to stop following it, and Notification Center shows it running
    /// and then ended. Needs X056_TEST_RICH_REPLY=1 (steps two seconds apart).
    func testLiveActivityFollowsASentTurn() throws {
        let app = signInToFixture()
        let projects = try XCTUnwrap(api("GET", "/api/projects")?["projects"] as? [[String: Any]])
        let site = try XCTUnwrap(projects.first { ($0["name"] as? String) == "Website refresh" })
        let conv = try XCTUnwrap((site["conversations"] as? [[String: Any]])?.first { ($0["title"] as? String) == "Update the component library" })
        for q in apiList("/api/questions") where q["sessionId"] as? String == conv["sessionId"] as? String {
            _ = api("POST", "/api/questions/dismiss", ["projectId": site["id"]!, "sessionId": conv["sessionId"]!, "at": q["at"]!])
        }
        app.buttons["Projects"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Website refresh"].waitForExistence(timeout: 10))
        app.staticTexts["Website refresh"].tap()
        let conversation = app.staticTexts["Update the component library"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        conversation.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("Run the checks.")
        app.buttons["send"].tap()
        // The turn's first step is in (its header names it, or counts them).
        XCTAssertTrue(app.buttons["steps"].firstMatch.waitForExistence(timeout: 15))

        app.buttons["More"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Stop following on Lock Screen"].waitForExistence(timeout: 5), "sending started a Live Activity")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.35)).tap() // closes the menu

        openNotificationCenter(app)
        snapshotScreen("30-live-activity-running")
        XCUIDevice.shared.press(.home)
        app.activate()
        // The turn is over once Stop gives way to Send again. (The fixture's
        // fake replies are not in its transcript, so a reload drops them.)
        XCTAssertTrue(app.buttons["send"].waitForExistence(timeout: 30))
        sleep(2)
        openNotificationCenter(app)
        snapshotScreen("31-live-activity-done")
        XCUIDevice.shared.press(.home)
        app.activate()
    }

    private func openNotificationCenter(_ app: XCUIApplication) {
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0))
        top.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.8)))
        sleep(2)
    }

    /// The whole screen (another app's, such as Notification Center).
    private func snapshotScreen(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot)
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
        if FileManager.default.fileExists(atPath: "/tmp/x056-shots") {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/x056-shots/\(name)-xc.png"))
        }
    }

    /// Read state is shared through the gateway: what the web marks shows on
    /// the phone, and the phone's reads reach the gateway. "The web" here is
    /// plain API calls to the fixture with its token.
    func testReadStateFollowsTheWeb() throws {
        let app = signInToFixture()
        XCTAssertTrue(app.staticTexts["Needs attention"].waitForExistence(timeout: 15))
        let projects = try XCTUnwrap(api("GET", "/api/projects")?["projects"] as? [[String: Any]])
        let project = try XCTUnwrap(projects.first { ($0["name"] as? String) == "Website refresh" })
        let conv = try XCTUnwrap((project["conversations"] as? [[String: Any]])?.first { ($0["title"] as? String) == "Update the component library" })
        let ref: [String: Any] = ["projectId": project["id"]!, "sessionId": conv["sessionId"]!]
        let key = "\(ref["projectId"]!)::\(ref["sessionId"]!)"

        _ = api("POST", "/api/conversations/unread", ref)
        XCTAssertTrue(app.staticTexts["Unread"].waitForExistence(timeout: 10), "the web's mark shows on the phone")
        snapshot(app, "9-unread-from-web")
        _ = api("POST", "/api/conversations/read", ref)
        XCTAssertTrue(app.staticTexts["Unread"].waitForNonExistence(timeout: 10), "the web's read clears the phone")

        _ = api("POST", "/api/conversations/unread", ref)
        let row = app.staticTexts["Update the component library"].firstMatch
        XCTAssertTrue(app.staticTexts["Unread"].waitForExistence(timeout: 10))
        row.swipeRight()
        app.buttons["Read"].firstMatch.tap()
        let deadline = Date().addingTimeInterval(8)
        var read = false
        while Date() < deadline && !read {
            let items = api("GET", "/api/conversations/read-state")?["items"] as? [String: [String: Any]]
            read = (items?[key]?["unread"] as? Bool) == false
            if !read { usleep(300_000) }
        }
        XCTAssertTrue(read, "the phone's read reaches the gateway")
    }

    /// One JSON call to the fixture gateway, synchronously.
    private func api(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> [String: Any]? {
        request(method, path, body) as? [String: Any]
    }

    private func apiList(_ path: String) -> [[String: Any]] {
        request("GET", path, nil) as? [[String: Any]] ?? []
    }

    private func request(_ method: String, _ path: String, _ body: [String: Any]?) -> Any? {
        var req = URLRequest(url: URL(string: server + path)!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var out: Any?
        URLSession.shared.dataTask(with: req) { data, _, _ in
            out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        return out
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
        let screenshot = app.screenshot()
        let shot = XCTAttachment(screenshot: screenshot)
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
        // On iPhone Duo held open, XCTest captures a blank display. When the
        // host runs a watcher on this folder, ask it for a simctl screenshot.
        let dir = "/tmp/x056-shots"
        guard FileManager.default.fileExists(atPath: dir) else { return }
        // XCTest's own capture, readable without the result bundle.
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name)-xc.png"))
        // A simctl capture only when a watcher says it is there (.watcher).
        guard FileManager.default.fileExists(atPath: "\(dir)/.watcher") else { return }
        let request = "\(dir)/\(name).request"
        FileManager.default.createFile(atPath: request, contents: nil)
        for _ in 0..<30 where FileManager.default.fileExists(atPath: request) { usleep(100_000) }
    }
}
