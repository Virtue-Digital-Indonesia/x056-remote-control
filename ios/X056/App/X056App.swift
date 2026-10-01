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
                .tint(Palette.clay)
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

/// Native tabs. On iPhone Duo the system draws them, with each screen's
/// toolbar items, in the vertical bar beside the content; on other iPhones
/// they are the tab bar, and on iPad a sidebar.
struct MainView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack(path: $app.homePath) {
                    HomeView().routes()
                }
            }
            .badge(app.needsYouCount)
            Tab("Projects", systemImage: "folder", value: AppTab.projects) {
                NavigationStack(path: $app.path) {
                    ProjectsView().routes()
                }
            }
            Tab("Accounts", systemImage: "gauge.with.dots.needle.67percent", value: AppTab.accounts) {
                NavigationStack {
                    AccountsView()
                }
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack {
                    SearchView().routes()
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .tabBarMinimizeBehavior(.onScrollDown)
    }
}

extension View {
    /// Every tab pushes the same screens.
    func routes() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .project(let id):
                ConversationsView(projectId: id)
            case .conversation(let pid, let sid):
                ConversationView(projectId: pid, sessionId: sid)
            case .draft(let pid, let id):
                ConversationView(projectId: pid, sessionId: nil, draftID: id)
            }
        }
    }
}
