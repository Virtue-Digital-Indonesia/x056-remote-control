import SwiftUI

@main
struct X056App: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var app = AppModel.shared

    /// Debug builds take `-X056Appearance dark|light`: the iOS 27 simulator
    /// stores `simctl ui appearance` but does not apply it.
    private static var forcedScheme: ColorScheme? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-X056Appearance"), i + 1 < args.count {
            return args[i + 1] == "dark" ? .dark : .light
        }
        #endif
        return nil
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .tint(Color.accentColor)
                .preferredColorScheme(Self.forcedScheme)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: app.enterForeground()
            case .background: app.enterBackground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if app.isSignedIn {
            MainView()
        } else {
            LoginView()
        }
    }
}

struct MainView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.path) {
            ProjectsView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .project(let id):
                        ConversationsView(projectId: id)
                    case .conversation(let pid, let sid):
                        ConversationView(projectId: pid, sessionId: sid)
                    case .draft(let pid, _):
                        ConversationView(projectId: pid, sessionId: nil)
                    }
                }
        }
    }
}
