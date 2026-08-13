import CoreMotion
import Foundation

/// Wrist motion capture.
///
/// Only `CMMotionManager.deviceMotion` is used. It provides a fused attitude quaternion plus
/// gravity-removed user acceleration, which is exactly the input `@101/motion` expects, and it
/// avoids reimplementing sensor fusion on a battery-limited device.
///
/// HealthKit is deliberately never imported. 101 reads wrist *movement*, never heart rate, workout
/// state or any other health signal, so the app requests no health authorization at all and cannot
/// silently acquire it later.
@MainActor
final class MotionSource: ObservableObject {
    @Published private(set) var available = false
    @Published private(set) var running = false

    private let manager = CMMotionManager()
    private let queue = OperationQueue()

    init() {
        queue.name = "com.oneohone.watch.motion"
        queue.maxConcurrentOperationCount = 1
        available = manager.isDeviceMotionAvailable
    }

    /// - Parameter onSample: called on the main actor for each fused reading.
    func start(onSample: @escaping @MainActor (
        _ orientation: (x: Float, y: Float, z: Float, w: Float),
        _ acceleration: (x: Float, y: Float, z: Float),
        _ rotationRate: (x: Float, y: Float, z: Float)
    ) -> Void) {
        guard manager.isDeviceMotionAvailable, !running else { return }
        // 100 Hz at the sensor gives the relay headroom to pick a clean 50 Hz without aliasing.
        manager.deviceMotionUpdateInterval = 1.0 / 100.0
        running = true
        manager.startDeviceMotionUpdates(to: queue) { motion, _ in
            guard let motion else { return }
            let q = motion.attitude.quaternion
            let a = motion.userAcceleration
            let r = motion.rotationRate
            let degrees = 180.0 / Double.pi
            Task { @MainActor in
                onSample(
                    (Float(q.x), Float(q.y), Float(q.z), Float(q.w)),
                    (Float(a.x), Float(a.y), Float(a.z)),
                    (Float(r.x * degrees), Float(r.y * degrees), Float(r.z * degrees))
                )
            }
        }
    }

    func stop() {
        guard running else { return }
        manager.stopDeviceMotionUpdates()
        running = false
    }
}
