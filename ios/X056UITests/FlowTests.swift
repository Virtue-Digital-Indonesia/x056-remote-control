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
        // A turn starting never clears a card, and a message that answers
        // nothing leaves it open: only an answer on the card (or the chat
        // resolving it) closes it.
        // The fixture's reply asks two questions of its own, which the gateway
        // merges into the open card: it then reads "3 questions".
        let card = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label MATCHES %@", "Which landing page should we publish?", "[0-9]+ questions")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), "an unrelated message leaves the card open")
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

        // Select Text opens the reply as it reads, to copy a part of it.
        app.staticTexts["What I need from you"].press(forDuration: 1.2)
        let selectText = app.buttons["Select Text"]
        XCTAssertTrue(selectText.waitForExistence(timeout: 5), "the long-press menu offers Select Text")
        XCTAssertTrue(app.buttons["Copy"].exists)
        selectText.tap()
        let selectable = app.textViews["select-text"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 5))
        let shown = selectable.value as? String ?? ""
        XCTAssertTrue(shown.contains("What I need from you"), shown)
        XCTAssertTrue(shown.contains("Public specimen lookup"), "the table's cells")
        XCTAssertFalse(shown.contains("**") || shown.contains("|---") || shown.contains("## "), "no Markdown marks: \(shown)")
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 2), "it opens with everything selected")
        snapshot(app, "14-select-text")
        app.buttons["Done"].tap()
        XCTAssertTrue(selectable.waitForNonExistence(timeout: 5))

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
        // Right after sign-in a tab can take a tap before it can act on it.
        let projectsTab = app.buttons["Projects"].firstMatch
        XCTAssertTrue(projectsTab.waitForExistence(timeout: 10))
        for _ in 0..<20 where !projectsTab.isHittable { usleep(250_000) }
        projectsTab.tap()
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

    /// New work started inside a Project (space) belongs to it on the
    /// gateway. It used to go to the repository route and land in none. A
    /// new Project has no repository of its own: any one can be chosen.
    func testNewWorkLandsInItsProject() throws {
        let name = "Phone project " + String(UUID().uuidString.prefix(4))
        let space = try XCTUnwrap(api("POST", "/api/project-spaces", ["requestId": UUID().uuidString.lowercased(), "name": name]))
        let spaceId = try XCTUnwrap(space["id"] as? String)
        let app = signInToFixture()
        app.buttons["Projects"].firstMatch.tap()
        let row = app.staticTexts[name].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        app.buttons["New conversation"].firstMatch.tap()
        let work = app.buttons["Work"].firstMatch
        if work.waitForExistence(timeout: 5) { work.tap() }
        XCTAssertFalse(app.buttons["Create"].firstMatch.isEnabled, "no repository chosen yet")
        // A menu picker's button is labelled by its value.
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "Repository", "Choose one")).firstMatch.tap()
        let repo = app.buttons["Website refresh"].firstMatch
        XCTAssertTrue(repo.waitForExistence(timeout: 5))
        repo.tap()
        snapshot(app, "50-new-work-in-project")
        app.buttons["Create"].firstMatch.tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 10))
        let inSpace = { () -> Int in
            let projects = self.api("GET", "/api/projects")?["projects"] as? [[String: Any]] ?? []
            return projects.flatMap { ($0["conversations"] as? [[String: Any]]) ?? [] }.filter { $0["spaceId"] as? String == spaceId }.count
        }
        XCTAssertEqual(inSpace(), 1, "the new work belongs to the project it was made in")
    }

    /// A message queued elsewhere (here: the API, as the web panel does)
    /// shows over the message box, not behind a chip off the screen.
    func testQueuedMessagesShowOverTheComposer() throws {
        let app = signInToFixture()
        app.buttons["Projects"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Website refresh"].waitForExistence(timeout: 10))
        app.staticTexts["Website refresh"].tap()
        let title = "Update the component library"
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
        app.staticTexts[title].tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 10))
        let ref = try conversationRef(title)
        _ = api("POST", "/api/sessions/current/messages", ref.merging(["prompt": "Run the checks."]) { a, _ in a })
        sleep(1)
        _ = api("POST", "/api/queue", ref.merging(["prompt": "Then deploy it"]) { a, _ in a })
        XCTAssertTrue(app.staticTexts["1 queued"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Then deploy it"].exists)
        snapshot(app, "51-queue-strip")
    }

    /// A long message shows Expand. Reading back while a turn runs stays
    /// where it was: the turn's steps used to scroll the view back down
    /// under the finger.
    func testExpandAndReadingBackDuringATurn() throws {
        let app = signInToFixture()
        app.buttons["Projects"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Website refresh"].waitForExistence(timeout: 10))
        app.staticTexts["Website refresh"].tap()
        let title = "Review accessibility findings"
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10))
        let ref = try conversationRef(title)
        for q in apiList("/api/questions") where q["sessionId"] as? String == ref["sessionId"] as? String {
            _ = api("POST", "/api/questions/dismiss", ref.merging(["at": q["at"]!]) { a, _ in a })
        }
        app.staticTexts[title].tap()
        XCTAssertTrue(app.textViews["composer"].waitForExistence(timeout: 10))
        let long = (["Run the checks, in this order:"] + (1...20).map { "step \($0) of the list" }).joined(separator: "\n")
        _ = api("POST", "/api/sessions/current/messages", ref.merging(["prompt": long]) { a, _ in a })
        XCTAssertTrue(app.buttons["steps"].firstMatch.waitForExistence(timeout: 15), "the turn is running")

        let expand = app.buttons["Expand"].firstMatch
        XCTAssertTrue(expand.waitForExistence(timeout: 5), "a cut message says it can be expanded")
        snapshot(app, "53-expand")
        expand.tap()
        XCTAssertTrue(app.buttons["Collapse"].firstMatch.waitForExistence(timeout: 3))
        app.buttons["Collapse"].firstMatch.tap()

        app.swipeDown()
        app.swipeDown()
        sleep(2)
        let marker = try XCTUnwrap(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "(#")).allElementsBoundByIndex.first {
            $0.isHittable && $0.frame.minY > 200 && $0.frame.minY < 600
        })
        let before = marker.frame.minY
        sleep(6) // more steps arrive meanwhile
        XCTAssertEqual(marker.frame.minY, before, accuracy: 2, "the turn's steps must not move what you are reading")
        XCTAssertTrue(app.buttons["Latest"].exists)
        snapshot(app, "52-reading-back-mid-turn")
        app.buttons["Latest"].tap()
        XCTAssertTrue(app.buttons["Collapse"].firstMatch.exists || app.buttons["Expand"].firstMatch.waitForExistence(timeout: 5), "Latest goes back to the end")
    }

    /// The Bot: woken from its tab, it answers; its setup message stays out
    /// of sight, and the chat is named Bot on the gateway.
    func testBotWakesAndAnswers() throws {
        // A Bot an earlier run left would skip the welcome.
        for p in (api("GET", "/api/projects")?["projects"] as? [[String: Any]] ?? []) where (p["name"] as? String) == "Bot" {
            _ = api("POST", "/api/projects/rename", ["id": p["id"]!, "name": "Old bot"])
        }
        let app = signInToFixture()
        // Right after sign-in the side bar can still be laying out (hit
        // point -1,-1): wait until the tab can take a tap.
        let botTab = app.buttons["Bot"].firstMatch
        XCTAssertTrue(botTab.waitForExistence(timeout: 10))
        for _ in 0..<20 where !botTab.isHittable { usleep(250_000) }
        botTab.tap()
        XCTAssertTrue(app.staticTexts["Meet your Bot"].waitForExistence(timeout: 10))
        let projectsTab = app.buttons["Projects"].firstMatch
        XCTAssertFalse(projectsTab.exists && projectsTab.isHittable, "the Bot covers the tabs and search")
        sleep(2)
        snapshot(app, "40-bot-welcome")
        app.buttons["Wake the Bot"].tap()
        // The gateway's Bot has its own persona, so waking sends nothing:
        // the home shows with its suggestions.
        let chip = app.buttons["What's running?"].firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 20))
        XCTAssertEqual(api("GET", "/api/bot")?["enabled"] as? Bool, true, "Wake turns the gateway's Bot on")
        sleep(2)
        snapshot(app, "41-bot-home")
        chip.tap()
        XCTAssertTrue(app.staticTexts["What's running?"].waitForExistence(timeout: 5))
        sleep(1)
        snapshot(app, "42-bot-thinking")
        XCTAssertTrue(app.staticTexts["Fixture response received."].waitForExistence(timeout: 40))
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "[Bot setup]")).firstMatch.exists, "the gateway's Bot gets no setup message")
        let named = (api("GET", "/api/projects")?["projects"] as? [[String: Any]] ?? []).filter { ($0["name"] as? String) == "Bot" }
        XCTAssertEqual(named.count, 1, "one Bot: the gateway's own")
        XCTAssertEqual(named.first?["bot"] as? Bool, true)

        // A reply's long-press menu selects text too.
        app.staticTexts["Fixture response received."].firstMatch.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Select Text"].waitForExistence(timeout: 5))
        app.buttons["Select Text"].tap()
        let reply = app.textViews["select-text"].value as? String ?? ""
        XCTAssertTrue(reply.hasPrefix("Fixture response received."), reply)
        XCTAssertFalse(reply.contains("**"), "shown as it reads: \(reply)")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.textViews["select-text"].waitForNonExistence(timeout: 5))

        // The morning brief's trigger is system history: shown on request,
        // folded away again. (The fixture answers every turn with the same
        // text, which the stream drops as a replay, so the brief's own reply
        // cannot be told apart here; BotHistoryTests covers that it shows.)
        _ = api("POST", "/api/bot/brief", [:])
        let trigger = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Morning brief for")).firstMatch
        // The panel's wording: "Show N hidden system messages", then a
        // "Showing system messages · Hide" pill over the thread.
        let show = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Show ", "hidden system message")).firstMatch
        let deadline = Date().addingTimeInterval(30)
        repeat {
            app.buttons["More"].firstMatch.tap()
            if show.waitForExistence(timeout: 2), show.isEnabled { break }
            app.tap()
            sleep(1)
        } while Date() < deadline
        show.tap()
        XCTAssertTrue(trigger.waitForExistence(timeout: 30), "system messages show the brief's trigger")
        XCTAssertTrue(app.staticTexts["Morning brief request"].exists)
        sleep(1)
        snapshot(app, "44-bot-system-history")
        app.buttons["Showing system messages · Hide"].firstMatch.tap()
        XCTAssertTrue(trigger.waitForNonExistence(timeout: 5), "and folds it away by default")

        // Return in the Bot's box is a newline that carries a list on; the
        // arrow button sends.
        let input = app.textViews["bot-input"]
        input.tap()
        input.typeText("- check builds\nread mail")
        XCTAssertEqual(input.value as? String, "- check builds\n- read mail")
        XCTAssertFalse(app.staticTexts["read mail"].exists, "Return did not send")
        snapshot(app, "43-bot-list")

        // Back is the way out, to the tab the Bot was opened from.
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(projectsTab.waitForExistence(timeout: 5))
        for _ in 0..<20 where !projectsTab.isHittable { usleep(250_000) }
        XCTAssertTrue(projectsTab.isHittable)
        XCTAssertFalse(app.staticTexts["What's running?"].exists)

        // A link to the Bot's chat (a push or a Live Activity) opens the Bot,
        // not its chat as a plain conversation.
        if let bot = named.first, let pid = bot["id"] as? String,
           let sid = (bot["conversations"] as? [[String: Any]])?.first?["sessionId"] as? String,
           let url = URL(string: "x056://conversation?projectId=\(pid)&sessionId=\(sid)") {
            XCUIDevice.shared.system.open(url)
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            if springboard.buttons["Open"].waitForExistence(timeout: 2) { springboard.buttons["Open"].tap() }
            XCTAssertTrue(app.textViews["bot-input"].waitForExistence(timeout: 10), "the Bot screen")
            XCTAssertFalse(projectsTab.isHittable, "over the tabs")
            snapshot(app, "45-bot-from-link")
            app.buttons["Back"].firstMatch.tap()
            XCTAssertTrue(app.textViews["bot-input"].waitForNonExistence(timeout: 5))
        } else {
            XCTFail("the Bot's chat has no conversation")
        }

        // Off again: on, the Bot wakes on every later test's urgent notice and
        // its chat turns up unread on their Home screens.
        _ = api("POST", "/api/bot", ["enabled": false])
        if let bot = named.first, let pid = bot["id"], let sid = (bot["conversations"] as? [[String: Any]])?.first?["sessionId"] {
            _ = api("POST", "/api/conversations/read", ["projectId": pid, "sessionId": sid])
        }
    }

    /// The message box writes Markdown: Return carries a list on, Return on
    /// an empty item ends it, numbers count up, and Format wraps a selection.
    func testComposerWritesMarkdown() throws {
        let app = signInToFixture()
        let projectsTab = app.buttons["Projects"].firstMatch
        XCTAssertTrue(projectsTab.waitForExistence(timeout: 10))
        for _ in 0..<20 where !projectsTab.isHittable { usleep(250_000) }
        projectsTab.tap()
        let project = app.staticTexts["Website refresh"].firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        let conversation = app.staticTexts["Review accessibility findings"].firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        conversation.tap()
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("make it bold")
        composer.press(forDuration: 1.2)
        tapMenu(app, "Select All")
        tapMenu(app, "Format")
        tapMenu(app, "Bold")
        XCTAssertEqual(composer.value as? String, "**make it bold**")
        snapshot(app, "51-composer-bold")

        // To the end of that line, then a list.
        composer.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        composer.typeText("\nBuy:\n- milk\neggs\n\n1. one\ntwo\n")
        XCTAssertEqual(composer.value as? String, "**make it bold**\nBuy:\n- milk\n- eggs\n1. one\n2. two\n3. ")
        snapshot(app, "50-composer-lists")
    }

    /// Taps an edit-menu item, paging the menu until it shows.
    private func tapMenu(_ app: XCUIApplication, _ label: String) {
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        for _ in 0..<4 where !item.waitForExistence(timeout: 1.5) {
            let next = app.buttons["Next Page"].firstMatch
            guard next.exists, next.isHittable else { break }
            next.tap()
        }
        XCTAssertTrue(item.exists, "\(label) in the edit menu")
        item.tap()
    }

    /// Opens the Bot from its tab, waking it on a fixture that has none yet.
    private func openBot(_ app: XCUIApplication) {
        let botTab = app.buttons["Bot"].firstMatch
        XCTAssertTrue(botTab.waitForExistence(timeout: 10))
        for _ in 0..<20 where !botTab.isHittable { usleep(250_000) }
        botTab.tap()
        let wake = app.buttons["Wake the Bot"]
        if wake.waitForExistence(timeout: 5) { wake.tap() }
    }

    private func conversationRef(_ title: String) throws -> [String: Any] {
        let projects = try XCTUnwrap(api("GET", "/api/projects")?["projects"] as? [[String: Any]])
        let site = try XCTUnwrap(projects.first { ($0["name"] as? String) == "Website refresh" })
        let conv = try XCTUnwrap((site["conversations"] as? [[String: Any]])?.first { ($0["title"] as? String) == title })
        return ["projectId": site["id"]!, "sessionId": conv["sessionId"]!]
    }

    /// Read state is shared through the gateway: what the web marks shows on
    /// the phone, and the phone's reads reach the gateway. "The web" here is
    /// plain API calls to the fixture with its token.
    func testReadStateFollowsTheWeb() throws {
        // What earlier tests left unread would keep an "Unread" on screen.
        _ = api("POST", "/api/conversations/read-all", [:])
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

    /// A card with no options takes its answer in its own box, and the server
    /// closes it, because the answer names the card. An agent's close of a
    /// card shows as one line, live and again after a reload.
    func testQuestionCardAnswersAndAgentLines() throws {
        let projects = try XCTUnwrap(api("GET", "/api/projects")?["projects"] as? [[String: Any]])
        let site = try XCTUnwrap(projects.first { ($0["name"] as? String) == "Website refresh" })
        let pid = try XCTUnwrap(site["id"] as? String)
        let conv = try XCTUnwrap((site["conversations"] as? [[String: Any]])?.first { ($0["title"] as? String) == "Update the component library" })
        let sid = try XCTUnwrap(conv["sessionId"] as? String)
        let ref: [String: Any] = ["from": sid, "projectId": pid, "sessionId": sid]
        func clearCards() {
            for q in apiList("/api/questions") where q["sessionId"] as? String == sid {
                _ = api("POST", "/api/questions/dismiss", ["projectId": pid, "sessionId": sid, "at": q["at"]!])
            }
        }
        clearCards()
        let asked = api("POST", "/api/questions/ask", ref.merging(["questions": [["question": "What should the footer say?", "options": [String]()]]]) { a, _ in a })
        XCTAssertNotNil(asked?["at"], "the fixture opened the card")

        let app = signInToFixture()
        app.buttons["Projects"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Website refresh"].waitForExistence(timeout: 10))
        app.staticTexts["Website refresh"].tap()
        XCTAssertTrue(app.staticTexts["Update the component library"].waitForExistence(timeout: 10))
        app.staticTexts["Update the component library"].tap()

        // The card's own answer box, not "write it in the message box".
        XCTAssertTrue(app.staticTexts["What should the footer say?"].waitForExistence(timeout: 10))
        let field = app.textFields["Your answer: What should the footer say?"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Send answer"].isEnabled, "nothing to send yet")
        field.tap()
        field.typeText("Contact us any time")
        snapshot(app, "15-card-answer")
        app.buttons["Send answer"].tap()
        XCTAssertTrue(app.staticTexts["Contact us any time"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["What should the footer say?"].waitForNonExistence(timeout: 15), "the answer closes the card")
        XCTAssertFalse(apiList("/api/questions").contains { ($0["question"] as? String) == "What should the footer say?" }, "the gateway closed the card")
        XCTAssertTrue(app.staticTexts["Fixture response received."].waitForExistence(timeout: 30))
        // The turn ends first: a rich reply's own questions would join the next card.
        for _ in 0..<30 {
            let rows = api("GET", "/api/projects")?["projects"] as? [[String: Any]] ?? []
            let busy = rows.first { ($0["id"] as? String) == pid }.map { (($0["runningSessionIds"] as? [String] ?? []) + ($0["backgroundSessionIds"] as? [String] ?? [])).contains(sid) } ?? true
            if !busy { break }
            sleep(1)
        }
        sleep(1)

        // The conversation's own agent closes a fresh card: one line, live.
        clearCards()
        let font = try XCTUnwrap(api("POST", "/api/questions/ask", ref.merging(["questions": [["question": "Serif or sans for the footer?", "options": ["Serif", "Sans"]]]]) { a, _ in a }))
        XCTAssertTrue(app.staticTexts["Serif or sans for the footer?"].waitForExistence(timeout: 10))
        _ = api("POST", "/api/questions/close", ref.merging(["at": font["at"]!, "action": "dismiss", "reason": "settled in the chat"]) { a, _ in a })
        let line = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", "Question dismissed by", "settled in the chat"))
        XCTAssertTrue(line.firstMatch.waitForExistence(timeout: 10), "the agent's close shows live")
        XCTAssertTrue(app.staticTexts["Serif or sans for the footer?"].waitForNonExistence(timeout: 10))
        snapshot(app, "16-agent-closed-card")

        // A reload holds the same line once, not twice.
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Update the component library"].waitForExistence(timeout: 10))
        app.staticTexts["Update the component library"].tap()
        XCTAssertTrue(line.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(line.count, 1)
        clearCards()
    }

    /// A question the Bot asks with `message_owner {needsYou}` shows on the
    /// Bot screen as a card over its box, and an option there answers it.
    /// Sorts after testBotWakesAndAnswers, which needs a gateway with no Bot.
    func testBotWithAQuestionCard() throws {
        let bot = try XCTUnwrap(api("POST", "/api/bot", ["enabled": true]))
        let pid = try XCTUnwrap(bot["projectId"] as? String)
        let sid = try XCTUnwrap(bot["sessionId"] as? String)
        for q in apiList("/api/questions") where q["sessionId"] as? String == sid {
            _ = api("POST", "/api/questions/dismiss", ["projectId": pid, "sessionId": sid, "at": q["at"]!])
        }
        let asked = api("POST", "/api/bot/message", ["from": sid, "text": "Approve the footer copy?", "needsYou": true, "options": ["Approve", "Hold"]])
        XCTAssertEqual(asked?["needsYou"] as? Bool, true, "the fixture's Bot opened a card")

        let app = signInToFixture()
        openBot(app)
        let field = app.textFields["Your answer: Approve the footer copy?"]
        XCTAssertTrue(field.waitForExistence(timeout: 15), "the card is on the Bot screen")
        XCTAssertTrue(app.buttons["Hold"].exists)
        XCTAssertFalse(app.buttons["What needs me?"].exists, "the suggestions wait behind the card")
        sleep(1)
        snapshot(app, "46-bot-question-card")
        app.buttons["Approve"].firstMatch.tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: 15), "the answer closes the card")
        XCTAssertFalse(apiList("/api/questions").contains { $0["sessionId"] as? String == sid && ($0["question"] as? String)?.contains("footer copy") == true }, "the gateway closed the card")

        _ = api("POST", "/api/bot", ["enabled": false])
        _ = api("POST", "/api/conversations/read", ["projectId": pid, "sessionId": sid])
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
