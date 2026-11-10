// The app's screens around the windows: choosing a room, opening it, and the open room's banner and
// tabs.

import LibraryModel
import PhaseLock
import SwiftUI
import UIKit

/** how long a room lives from its creation, before the reaper erases it (rooms.ts) */
private let roomLifetime: TimeInterval = 60 * 60

struct RootView: View {
    let room: Room

    var body: some View {
        ZStack {
            Palette.ground.ignoresSafeArea()
            switch room.state {
            case .choosing: ChooseView(room: room, error: nil)
            case .opening: ProgressView()
            case .failed(let reason): ChooseView(room: room, error: reason)
            case .open(let windows): WindowsView(room: room, windows: windows)
            }
        }
    }
}

/** Which database and which room: a room's id joins it, as the web demo's invite does, and no id
    opens a new one.  The fields start from the server and room the app was last in. */
struct ChooseView: View {
    let room: Room
    let error: String?
    @State private var server = ""
    @State private var id = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("PhaseLock Library Demo").font(.title2.weight(.semibold))
            Muted(
                "A room is a private copy of the library for an hour.  Paste a room's id from the web demo "
                    + "to join it, or leave it blank for a room of your own."
            )
            TextField("Database", text: $server)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Room", text: $id)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            HStack(spacing: 8) {
                Button(id.isEmpty ? "New room" : "Open room") { room.open(server: server, room: id) }
                    .buttonStyle(.borderedProminent)
                if !id.isEmpty { Button("Clear") { id = "" } }
            }
            if let error { Text(error).foregroundStyle(Palette.alarm) }
        }
        .padding(24)
        .frame(maxWidth: 560)
        .onAppear {
            server = room.lastServer
            id = room.lastRoom
        }
    }
}

struct WindowsView: View {
    let room: Room
    let windows: Windows

    var body: some View {
        VStack(spacing: 0) {
            RoomBanner(room: room, windows: windows)
            TabView {
                DeskWindow(room: windows.room, window: windows.desk)
                    .tabItem { Label("Front Desk", systemImage: "building.columns") }
                PatronWindow(room: windows.room, window: windows.alice)
                    .tabItem { Label("Alice", systemImage: "person") }
                PatronWindow(room: windows.room, window: windows.bob)
                    .tabItem { Label("Bob", systemImage: "person.fill") }
            }
        }
    }
}

/** the room's id, which a web window joins it by, and how long until the room resets */
struct RoomBanner: View {
    let room: Room
    let windows: Windows
    @State private var created: LiveQuery<Date?>

    init(room: Room, windows: Windows) {
        self.room = room
        self.windows = windows
        _created = State(initialValue: LiveQuery(AdminQueries(windows.desk.engine).roomCreated()))
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Room \(windows.room.split(separator: "-").first.map(String.init) ?? windows.room)")
                    .font(.headline)

                // the countdown ticks on its own, since nothing in the room changes as the minutes
                // pass
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    if let c = created.value {
                        let left = max(0, Int(c.addingTimeInterval(roomLifetime).timeIntervalSince(context.date) / 60))
                        Muted("resets in \(left) min")
                    } else {
                        Muted("syncing…")
                    }
                }
            }
            Spacer()
            Button("Copy id") { UIPasteboard.general.string = windows.room }
            Button("Leave") { room.leave() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}
