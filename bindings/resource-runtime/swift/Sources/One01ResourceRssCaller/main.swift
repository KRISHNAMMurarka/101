import Foundation
import One01ResourceRss

let runtime = ResourceRssRuntime(approve: { action, _, now in
    now + (action == .register ? 10_000_000_000 : 1_000_000_000)
}, current: { epoch in epoch == 101 })
do {
    let handle = try runtime.start(epoch: 101).get()
    let sample = try runtime.read(handle).get()
    guard sample.epoch == 101, sample.sequence == 1, sample.rssBytes > 0 else { throw RssStatus.unavailable }
    runtime.stop()
    guard case .failure(.stale) = runtime.read(handle) else { throw RssStatus.stale }
    print("swift-self-rss:read-stop-pass")
} catch {
    fputs("swift-self-rss:failed\n", stderr)
    exit(1)
}
