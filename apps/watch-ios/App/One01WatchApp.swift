import SwiftUI
import WatchKit

@main
struct One01WatchApp: App {
    var body: some Scene {
        WindowGroup {
            ControllerView()
        }
    }
}

/// The whole watch UI. A watch face is small and the wearer is usually looking at the game, not
/// the wrist, so this shows only what cannot be inferred from the game: whether the route is up,
/// whether it is genuinely local, and a control to start or stop relaying.
struct ControllerView: View {
    @StateObject private var relay = WatchSessionRelay()
    @StateObject private var motion = MotionSource()
    @State private var crown = 0.0
    @State private var relaying = false

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Circle()
                    .fill(indicatorColor)
                    .frame(width: 10, height: 10)
                Text(relay.link.canRelayRealtime ? "LOCAL" : "OFFLINE")
                    .font(.system(.caption2, design: .monospaced))
                Spacer()
                Text("101")
                    .font(.system(.caption, design: .monospaced).bold())
            }

            Text(relay.statusNote)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button(relaying ? "Stop" : "Start") {
                relaying ? stop() : start()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!motion.available || !relay.link.canRelayRealtime)

            if relaying {
                Text("\(relay.sentCount) sent")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if !motion.available {
                Text("This watch reports no motion sensor.")
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 6)
        // The Digital Crown becomes a dial the game can bind, exactly like a rotary bezel does on
        // Wear OS. Travel is unbounded here; 101 turns it into a bounded axis on the phone side.
        .focusable(true)
        .digitalCrownRotation($crown, from: -1000, through: 1000, by: 1, sensitivity: .medium, isContinuous: true, isHapticFeedbackEnabled: true)
        .onTapGesture { sendTap() }
        .onAppear { relay.activate() }
        .onDisappear { stop() }
    }

    private var indicatorColor: Color {
        relay.link.canRelayRealtime ? .green : .orange
    }

    private func start() {
        relaying = true
        motion.start { orientation, acceleration, rotationRate in
            relay.relay(orientation: orientation, acceleration: acceleration, rotationRate: rotationRate, crown: Float(crown), tap: false)
        }
    }

    private func stop() {
        relaying = false
        motion.stop()
    }

    private func sendTap() {
        guard relaying else { return }
        WKInterfaceDevice.current().play(.click)
        relay.relay(orientation: (0, 0, 0, 1), acceleration: (0, 0, 0), rotationRate: (0, 0, 0), crown: Float(crown), tap: true)
    }
}
