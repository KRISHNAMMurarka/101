import com.oneohone.wear.WatchPayload
import java.io.ByteArrayOutputStream

// Offline inert caller of the unchanged JVM-compatible codec. No Android/Wear API is used.
private fun bytes(text: String): ByteArray? {
    if (text == "-") return ByteArray(0)
    if (text.length > 512 || text.length % 2 != 0 || text.any { it !in "0123456789abcdef" }) return null
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
private fun result(report: WatchPayload?): String {
    if (report == null) return "null"
    fun values(input: FloatArray) = input.joinToString(",", "[", "]") { it.toDouble().toString() }
    val hex = report.encode().joinToString("") { "%02x".format(it.toInt() and 255) }
    return "{\"hex\":\"$hex\",\"sequence\":${report.sequence},\"relayEmissionMs\":${report.milliseconds}," +
        "\"orientationReported\":${values(report.orientation)},\"accelerationG\":${values(report.acceleration)}," +
        "\"rotationDegPerSecond\":${values(report.rotationRate)},\"crownReported\":${report.crown.toDouble()},\"tap\":${report.tap}}"
}
private fun command(line: ByteArray): String {
    if (line.any { (it.toInt() and 255) !in 32..126 }) return "null"
    val fields = line.toString(Charsets.US_ASCII).split(' ')
    if (fields.size == 2 && fields[0] == "D") return result(bytes(fields[1])?.let(WatchPayload::decode))
    if (fields.size != 15 || fields[0] != "E" || fields[14] !in listOf("0", "1")) return "null"
    val sequence = fields[1].toIntOrNull() ?: return "null"
    val emission = fields[2].toLongOrNull() ?: return "null"
    if (sequence !in 0..65535 || emission !in 0L..4294967295L) return "null"
    val values = fields.subList(3, 14).map { it.toFloatOrNull() ?: return "null" }
    if (values.any { !it.isFinite() }) return "null"
    return result(WatchPayload(sequence, emission, values.subList(0, 4).toFloatArray(), values.subList(4, 7).toFloatArray(),
        values.subList(7, 10).toFloatArray(), values[10], fields[14] == "1"))
}
fun main() {
    val chunk = ByteArray(4096)
    val line = ByteArrayOutputStream(4096)
    var count = 0
    var outputBytes = 0
    while (true) {
        val size = System.`in`.read(chunk)
        if (size < 0) break
        for (index in 0 until size) {
            val value = chunk[index].toInt() and 255
            if (value == 10) {
                check(++count <= 128)
                val answer = command(line.toByteArray()) + "\n"
                outputBytes += answer.toByteArray(Charsets.UTF_8).size
                check(outputBytes <= 131072)
                System.out.print(answer); line.reset()
            } else {
                check(line.size() < 4096); line.write(value)
            }
        }
    }
    check(line.size() == 0)
}
