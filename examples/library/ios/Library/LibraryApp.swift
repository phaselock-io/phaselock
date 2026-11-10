// The app: choosing a room, then the room's three windows, one tab each, as the web demo shows
// them side by side.  Every window is signed in as its own user; the desk is a librarian's.

import SwiftUI

@main
struct LibraryApp: App {
    @State private var room = Room()

    var body: some Scene {
        WindowGroup {
            RootView(room: room)
                .preferredColorScheme(.dark)
                .tint(Palette.accent)
                .task {
                    // a launch with `-room <id>` opens that room at once, on the last server
                    let args = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
                    if let id = args["room"] as? String { room.open(server: room.lastServer, room: id) }
                }
        }
    }
}
