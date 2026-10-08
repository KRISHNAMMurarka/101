package one01.resourcerss

enum class RssAction(val code: Int) { REGISTER(1), READ(2) }
enum class RssStatus(val code: Int) { OK(0), DENIED(1), STALE(2), BUSY(3), LIMIT(4), UNAVAILABLE(5);
    companion object { fun from(code: Int): RssStatus = entries.firstOrNull { it.code == code } ?: UNAVAILABLE }
}
data class RssSample(val epoch: Long, val sequence: Int, val capturedAtNs: Long, val rssBytes: Long)

/** A local identity. Its native token is validated before any native pointer access. */
class RssHandle internal constructor(internal val ownerToken: Long, internal val handleToken: Long)
data class RssStart(val status: RssStatus, val handle: RssHandle? = null)
data class RssRead(val status: RssStatus, val sample: RssSample? = null)

/** Synchronous, thread-confined macOS own-process RSS; native C owns the Mach read. */
class ResourceRssRuntime(
    private val approve: (RssAction, Long, Long) -> Long?,
    private val current: (Long) -> Boolean
) : AutoCloseable {
    companion object { init { System.loadLibrary("one01rss") } }
    private val ownerThread = Thread.currentThread()
    private var nativeToken: Long = nativeCreate().also { check(it > 0L) { "native RSS runtime capacity" } }
    private val issuedHandles = arrayOfNulls<RssHandle>(2)

    @Suppress("unused")
    private fun approveNative(action: Int, epoch: Long, nowNs: Long): Long? =
        RssAction.entries.firstOrNull { it.code == action }?.let { approve(it, epoch, nowNs) }
    @Suppress("unused")
    private fun currentNative(epoch: Long): Boolean = current(epoch)

    private external fun nativeCreate(): Long
    private external fun nativeStart(runtimeToken: Long, epoch: Long): LongArray
    private external fun nativeRead(runtimeToken: Long, handleToken: Long): LongArray
    private external fun nativeStop(runtimeToken: Long)
    private external fun nativeDestroy(runtimeToken: Long)

    private fun requireOwner() {
        check(Thread.currentThread() === ownerThread) { "RSS runtime belongs to its creating thread" }
    }

    fun start(epoch: Long): RssStart {
        requireOwner()
        val row = nativeStart(nativeToken, epoch)
        val status = RssStatus.from(row[0].toInt())
        if (status != RssStatus.OK) return RssStart(status)
        val handle = RssHandle(nativeToken, row[1])
        val position = issuedHandles.indexOfFirst { it == null }
        check(position >= 0) { "native generation bound" }
        issuedHandles[position] = handle
        return RssStart(status, handle)
    }

    fun read(handle: RssHandle): RssRead {
        requireOwner()
        if (handle.ownerToken != nativeToken || nativeToken == 0L || issuedHandles.none { it === handle })
            return RssRead(RssStatus.STALE)
        val row = nativeRead(nativeToken, handle.handleToken)
        val status = RssStatus.from(row[0].toInt())
        return RssRead(status, if (status == RssStatus.OK)
            RssSample(row[1], row[2].toInt(), row[3], row[4]) else null)
    }

    fun stop() { requireOwner(); if (nativeToken != 0L) nativeStop(nativeToken) }
    override fun close() { requireOwner(); val token = nativeToken; nativeToken = 0L; if (token != 0L) nativeDestroy(token) }
}
