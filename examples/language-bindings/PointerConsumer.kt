import com.oneohone.pointerwire.PointerLane
import com.oneohone.pointerwire.PointerSample
import com.oneohone.pointerwire.PointerWire

private fun bytes(hex: String): ByteArray? = try {
    require(hex.length <= 2048 && hex.length % 2 == 0 && hex.all { it in "0123456789abcdef" })
    ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
} catch (_: IllegalArgumentException) { null }

fun main() {
    val epoch = ByteArray(16) { 0x11 }
    val sample = PointerSample(epoch, 1, 1, 0.0, 0.25, 0.75)
    val snapshot = PointerWire.encode(sample)
    epoch[0] = 0x22; sample.epoch[0] = 0x33
    check(PointerWire.encode(sample).contentEquals(snapshot)) { "Epoch bytes must remain private snapshots" }
    var count = 0
    generateSequence(::readLine).forEach { line ->
        require(++count <= 128 && line.length <= 4096)
        val fields = line.split(' ')
        val result = try {
            when {
                fields.size == 7 && fields[0] == "E" -> PointerWire.encode(PointerSample(
                    bytes(fields[1]) ?: throw IllegalArgumentException(), fields[2].toInt(), fields[3].toLong(),
                    fields[4].toDouble(), fields[5].toDouble(), fields[6].toDouble()))
                fields.size == 3 && fields[0] == "D" -> PointerWire.decode(bytes(fields[2]) ?: throw IllegalArgumentException(),
                    if (fields[1] == "disposable") PointerLane.DISPOSABLE else if (fields[1] == "reliable") PointerLane.RELIABLE else throw IllegalArgumentException())?.let(PointerWire::encode)
                else -> null
            }
        } catch (_: IllegalArgumentException) { null }
        println(result?.joinToString("", "{\"hex\":\"", "\"}") { "%02x".format(it.toInt() and 255) } ?: "null")
    }
}
