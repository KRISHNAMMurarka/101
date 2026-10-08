package one01.resourcerss

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference

private class ApprovalFixture {
    var register = false
    var read = false
    var current = false
    var expire = false
    var delay = false
    var stopDuringApproval = false
    var runtime: ResourceRssRuntime? = null
    fun approve(action: RssAction, epoch: Long, now: Long): Long? {
        if (stopDuringApproval) runtime?.stop()
        if (epoch <= 0 || !(if (action == RssAction.REGISTER) register else read)) return null
        val span = if (expire) 0L else if (delay) 1_000_000L else if (action == RssAction.REGISTER) 10_000_000_000L else 1_000_000_000L
        if (delay) Thread.sleep(3)
        return now + span
    }
}

object ResourceRssTests {
    @JvmStatic fun main(args: Array<String>) {
        val path = System.getenv("ONE01_RSS_CASES") ?: error("canonical fixture required")
        val fixture = File(path).readText()
        check(fixture.contains("\"profile\": \"self-current-rss-macos-mach/1\""))
        check(fixture.contains("\"clock\": \"CLOCK_MONOTONIC-ns\""))
        val cases = Regex("\\\"cases\\\"\\s*:\\s*\\[(.*?)]", RegexOption.DOT_MATCHES_ALL).find(fixture)?.groupValues?.get(1)
            ?.let { Regex("\\\"([^\\\"]+)\\\"").findAll(it).map { match -> match.groupValues[1] }.toList() } ?: error("cases")
        val passed = mutableListOf<String>()
        fun case(name: String, success: Boolean) { check(success) { name }; passed.add(name) }
        val f = ApprovalFixture()
        val runtime = ResourceRssRuntime(f::approve, { f.current }); f.runtime = runtime
        try {
            case("denied-register", runtime.start(11).status == RssStatus.DENIED)
            f.register = true; f.current = true; f.expire = true
            case("expired-register", runtime.start(11).status == RssStatus.DENIED)
            f.expire = false; f.stopDuringApproval = true
            case("stop-during-register", runtime.start(11).status == RssStatus.DENIED)
            f.stopDuringApproval = false
            val first = runtime.start(11).handle ?: error("accepted-register")
            case("accepted-register", runtime.start(12).status == RssStatus.BUSY)
            case("busy-register", runtime.start(12).status == RssStatus.BUSY)
            val other = ResourceRssRuntime({ _, _, now -> now + 1_000_000_000L }, { true })
            val foreign = other.start(99).handle ?: error("foreign-start")
            case("foreign-handle", runtime.read(foreign).status == RssStatus.STALE)
            other.close()
            case("denied-read", runtime.read(first).status == RssStatus.DENIED)
            f.read = true; f.expire = true
            case("expired-read", runtime.read(first).status == RssStatus.DENIED)
            f.expire = false
            val sample = runtime.read(first).sample ?: error("current-rss-read")
            case("current-rss-read", sample.epoch == 11L && sample.sequence == 1 && sample.rssBytes > 0 && sample.capturedAtNs > 0)
            f.delay = true
            case("delayed-read-approval", runtime.read(first).status == RssStatus.DENIED)
            f.delay = false; f.current = false
            case("current-revoked", runtime.read(first).status == RssStatus.DENIED)
            f.current = true; f.stopDuringApproval = true
            case("stop-during-read", runtime.read(first).status == RssStatus.DENIED)
            f.stopDuringApproval = false
            val second = runtime.start(12).handle ?: error("replacement-start")
            case("old-generation-stale", runtime.read(first).status == RssStatus.STALE)
            val replacement = runtime.read(second).sample ?: error("replacement-read")
            case("replacement-read", replacement.epoch == 12L && replacement.sequence == 1 && replacement.rssBytes > 0)
            var last = replacement
            for (index in 2..32) last = runtime.read(second).sample ?: error("read-$index")
            case("thirty-two-reads", last.sequence == 32 && runtime.read(second).status == RssStatus.LIMIT)
            runtime.stop()
            case("stop-stale", runtime.read(second).status == RssStatus.STALE)
            case("two-generation-limit", runtime.start(13).status == RssStatus.LIMIT)
            check(passed == cases) { "canonical case order differs: $passed" }
            lateinit var closing: ResourceRssRuntime
            closing = ResourceRssRuntime({ _, _, now -> closing.close(); now + 1_000_000_000L }, { true })
            check(closing.start(55).status == RssStatus.STALE)
            closing.close()
            println("kotlin-self-rss:${passed.size}-cases:pass")
        } finally { runtime.close() }

        val confined = ResourceRssRuntime({ _, _, now -> now + 1_000_000_000L }, { true })
        val wrongThreadFailure = AtomicReference<Throwable?>()
        val wrongThread = Thread {
            try { confined.close() } catch (cause: Throwable) { wrongThreadFailure.set(cause) }
        }
        wrongThread.start(); wrongThread.join()
        check(wrongThreadFailure.get() is IllegalStateException) { "foreign thread must not retire native owner" }
        check(confined.start(501).status == RssStatus.OK) { "owner remains usable after rejected foreign close" }
        confined.close()

        val ready = CountDownLatch(2)
        val go = CountDownLatch(1)
        val outcomes = arrayOfNulls<RssRead>(2)
        val failures = arrayOfNulls<Throwable>(2)
        val workers = (0..1).map { index -> Thread {
            try {
                ready.countDown(); go.await()
                ResourceRssRuntime({ _, _, now -> now + 1_000_000_000L }, { true }).use { own ->
                    val handle = own.start(601L + index).handle ?: error("parallel-start-$index")
                    outcomes[index] = own.read(handle)
                }
            } catch (cause: Throwable) { failures[index] = cause }
        } }
        workers.forEach(Thread::start)
        ready.await(); go.countDown()
        workers.forEach(Thread::join)
        check(failures.all { it == null } && outcomes.all { it?.status == RssStatus.OK && (it.sample?.rssBytes ?: 0L) > 0L }) {
            "independent thread-confined instances must each own a native slot: ${failures.toList()} ${outcomes.toList()}"
        }
        println("kotlin-native-slot-and-owner:pass")
    }
}
