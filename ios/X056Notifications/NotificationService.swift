import Intents
import UserNotifications

/// Gives a Bot push the Bot's face. iOS draws every push with the app icon
/// unless it is a communication notification: then the sender's picture
/// leads and the app icon sits small in its corner. The gateway marks a Bot
/// push (`bot: true`, `mutable-content`); any other push passes unchanged.
final class NotificationService: UNNotificationServiceExtension {
    private var deliver: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        deliver = contentHandler
        original = request.content
        contentHandler(Self.dressed(request.content))
    }

    override func serviceExtensionTimeWillExpire() {
        if let deliver, let original { deliver(original) }
    }

    /// The push as a message from the Bot. Its title is the Bot's chat, so
    /// the Bot's name; that becomes the sender, and the body stays the body.
    static func dressed(_ content: UNNotificationContent) -> UNNotificationContent {
        guard content.userInfo["bot"] as? Bool == true else { return content }
        let name = content.title.isEmpty ? "Bot" : content.title
        let face = Bundle.main.url(forResource: "BotAvatar", withExtension: "png")
            .flatMap { try? Data(contentsOf: $0) }
            .map { INImage(imageData: $0) }
        let bot = INPerson(personHandle: INPersonHandle(value: "x056-bot", type: .unknown),
                           nameComponents: nil, displayName: name, image: face,
                           contactIdentifier: nil, customIdentifier: "x056-bot")
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: content.body, speakableGroupName: nil,
                                         conversationIdentifier: content.threadIdentifier,
                                         serviceName: nil, sender: bot, attachments: nil)
        intent.setImage(face, forParameterNamed: \.sender)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)
        // Without the entitlement or with a bad intent this throws: the
        // push still shows, just with the app icon.
        return (try? content.updating(from: intent)) ?? content
    }
}
