package one01.resourcerss

object ResourceRssCaller {
    @JvmStatic fun main(args: Array<String>) {
        ResourceRssRuntime(
            approve = { action, epoch, now -> if (epoch == 101L)
                now + if (action == RssAction.REGISTER) 10_000_000_000L else 1_000_000_000L else null },
            current = { it == 101L }
        ).use { runtime ->
            val handle = runtime.start(101L).handle ?: error("registration denied")
            val sample = runtime.read(handle).sample ?: error("read denied")
            check(sample.epoch == 101L && sample.sequence == 1 && sample.rssBytes > 0L)
            runtime.stop()
            check(runtime.read(handle).status == RssStatus.STALE)
            println("kotlin-self-rss:read-stop-pass")
        }
    }
}
