import UIKit
import UserNotifications

/// APNs registration. The token is posted to the gateway, which sends the same
/// events the panel's Web Push does (finished, failed, needs you, interrupted).
enum Push {
    static let replyCategory = "X056_REPLY"
    static let replyAction = "X056_REPLY_ACTION"

    static var deviceToken: String? {
        get { UserDefaults.standard.string(forKey: "apnsToken") }
        set { UserDefaults.standard.set(newValue, forKey: "apnsToken") }
    }

    @MainActor
    static func requestAndRegister() async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    static func categories() -> Set<UNNotificationCategory> {
        let reply = UNTextInputNotificationAction(
            identifier: replyAction, title: "Reply", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        return [UNNotificationCategory(identifier: replyCategory, actions: [reply], intentIdentifiers: [], options: [])]
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Push.categories())
        if AppModel.shared.isSignedIn {
            // Tokens can change across reinstalls and restores; re-register every launch.
            Task { await Push.requestAndRegister() }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Push.deviceToken = hex
        Task { await AppModel.shared.registerDevice(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppModel.shared.pushError = error.localizedDescription
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let sid = notification.request.content.userInfo["sessionId"] as? String
        let visible = await MainActor.run { AppModel.shared.visibleSessionId }
        // The conversation is already on screen: the update is right there.
        if let sid, sid == visible { return [] }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let pid = info["projectId"] as? String ?? ""
        let sid = info["sessionId"] as? String
        if response.actionIdentifier == Push.replyAction, let sid,
           let text = (response as? UNTextInputNotificationResponse)?.userText {
            await AppModel.shared.replyFromNotification(projectId: pid, sessionId: sid, text: text)
            return
        }
        await MainActor.run { AppModel.shared.open(projectId: pid, sessionId: sid) }
    }
}
