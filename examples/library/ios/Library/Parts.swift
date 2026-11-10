// The pieces every window is built from.

import LibraryModel
import Network
import PhaseLock
import SwiftUI

/** a patron's marker: the first letter of their name, in their color */
struct PatronAvatar: View {
    let name: String
    let color: String
    var size: CGFloat = 24

    var body: some View {
        Text(name.prefix(1).uppercased())
            .font(.system(size: size * 0.55, weight: .semibold))
            .foregroundStyle(Palette.onAccent)
            .frame(width: size, height: size)
            .background(colorOf(color), in: Circle())
    }
}

/** a section's heading: small, muted capitals, with an action at its end */
struct SectionTitle<Action: View>: View {
    let title: String
    @ViewBuilder var action: Action

    var body: some View {
        HStack {
            Text(title.uppercased()).font(.caption).kerning(1).foregroundStyle(Palette.muted)
            Spacer()
            action
        }
        .padding(.top, 16)
        .padding(.bottom, 4)
    }
}

extension SectionTitle where Action == EmptyView {
    init(_ title: String) {
        self.init(title: title) { EmptyView() }
    }
}

/** a muted line of small text */
struct Muted: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).font(.footnote).foregroundStyle(Palette.muted)
    }
}

/** Whether the device has a network at all, as one app-wide monitor sees it.  It reads available
    until the first report, so a switch it disables never flashes grey at launch. */
@MainActor @Observable
final class NetworkPath {
    static let shared = NetworkPath()

    private(set) var available = true
    @ObservationIgnored private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            MainActor.assumeIsolated { self?.available = available }
        }
        monitor.start(queue: .main)
    }
}

/** The state of a window's connection, and the switch that takes it offline and back, which
    reconnects at once.  It keeps the connection's state alone from the Engine's status, so a
    status that changes otherwise, as progress does through a sync, redraws nothing.  While the
    device has no network, the switch reads off and is disabled, and the user's choice returns
    with the network. */
struct ConnectionSwitch: View {
    let transport: SwitchedTransport
    let reconnectNow: () -> Void
    @State private var connection: LiveQuery<ConnectionStatus.State?>
    @State private var online = true

    init(status: QueryResults<EngineStatus>, transport: SwitchedTransport, reconnectNow: @escaping () -> Void) {
        self.transport = transport
        self.reconnectNow = reconnectNow
        _connection = State(initialValue: LiveQuery(status.map { $0.connection.state }))
    }

    private var state: ConnectionStatus.State? { connection.value }
    private var network: NetworkPath { NetworkPath.shared }

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(name).font(.footnote).foregroundStyle(Palette.muted).fixedSize()
            Toggle("Online", isOn: Binding(get: { online && network.available }, set: { online = $0 }))
                .labelsHidden()
                .disabled(!network.available)
        }
        .layoutPriority(1)
        .onAppear { online = transport.isOnline }
        .onChange(of: online) { _, on in
            transport.setOnline(on)
            if on { reconnectNow() }
        }
    }

    private var color: Color {
        switch state {
        case .live: Palette.accent
        case .syncing: Palette.amber
        case .offline: Palette.alarm
        case .connecting, nil: Palette.muted
        }
    }

    private var name: String {
        switch state {
        case .live: "live"
        case .syncing: "syncing"
        case .offline: "offline"
        case .connecting, nil: "connecting"
        }
    }
}

/** a notice the window's user dismisses */
struct NoticeCard: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Text(text).foregroundStyle(Palette.amber)
            Spacer()
            Button("Dismiss", action: onDismiss)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Palette.amber.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}

/** a name or a title being changed: what the dialog asks for, what it holds now, and where a new
    one goes */
struct Renaming: Identifiable {
    let id = UUID()
    let label: String
    let value: String
    let save: (String) -> Void
}

/** A dialog asking for a name: one that changed and is not blank goes to its save. */
struct NameDialog: ViewModifier {
    @Binding var renaming: Renaming?
    @State private var draft = ""

    func body(content: Content) -> some View {
        content.alert(
            renaming?.label ?? "",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
            presenting: renaming
        ) { r in
            TextField(r.label, text: $draft)
            Button("Save") {
                let name = draft.trimmingCharacters(in: .whitespaces)
                if !name.isEmpty && name != r.value { r.save(name) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .onChange(of: renaming?.id) { draft = renaming?.value ?? "" }
    }
}

extension View {
    func nameDialog(_ renaming: Binding<Renaming?>) -> some View {
        modifier(NameDialog(renaming: renaming))
    }
}

/** A button as the web demo draws one: light text and a thin border over a near-black ground,
    turning green while pressed, and gray throughout while disabled.  It fills the width it is
    offered, so buttons stacked in a column of their widest share one width.  A side squared off
    joins it to a button beside it. */
struct QuietButtonStyle: ButtonStyle {
    // the side squared off, if any
    var joined: HorizontalEdge?
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = isEnabled && configuration.isPressed
        let leading: CGFloat = joined == .leading ? 0 : 4
        let trailing: CGFloat = joined == .trailing ? 0 : 4
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: leading,
            bottomLeadingRadius: leading,
            bottomTrailingRadius: trailing,
            topTrailingRadius: trailing
        )
        configuration.label
            .font(.subheadline)
            .foregroundStyle(isEnabled ? (pressed ? Palette.accent : Palette.text) : Palette.disabledText)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .background(pressed ? Palette.buttonPressed : Palette.buttonGround, in: shape)
            .overlay(shape.stroke(isEnabled ? (pressed ? Palette.accent : Palette.border) : Palette.disabledBorder))
    }
}

extension ButtonStyle where Self == QuietButtonStyle {
    static var quiet: QuietButtonStyle { QuietButtonStyle() }
}

/** a pencil that edits what it follows, described by what it does */
struct EditButton: View {
    let description: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Image(systemName: "pencil") }
            .buttonStyle(.borderless)
            .accessibilityLabel(description)
    }
}

/** Children laid out in rows, each row as wide as fits, as chips wrap. */
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        rows(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, p) in rows(subviews, width: bounds.width).places.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }

    // each child's place, and the size of them all
    private func rows(_ subviews: Subviews, width: CGFloat) -> (places: [CGPoint], size: CGSize) {
        var places: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            places.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (places, CGSize(width: widest, height: y + rowHeight))
    }
}

/** a date as a reader says it, such as "Oct 21" */
func day(_ date: Date) -> String {
    date.formatted(.dateTime.month(.abbreviated).day())
}
