package one01.structuredtelemetry

import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.PrintStream
import java.io.StringReader
import java.nio.charset.StandardCharsets
import kotlin.system.exitProcess

// Ordinary offline JVM caller. No transport, identity, sensor, grants, native device or clock API is used.
object StructuredTelemetryConsumer {
    private const val MAX_COMMANDS = 128
    private const val MAX_LINE_BYTES = 16384
    private const val MAX_TOTAL_BYTES = 1048576
    private class FramingException : Exception("invalid")
    private val gson = GsonBuilder().setStrictness(Strictness.STRICT).disableHtmlEscaping().create()
    private val elementAdapter = gson.getAdapter(JsonElement::class.java)

    private fun bytes(hex: String): ByteArray? {
        if (hex.isEmpty() || hex.length > StructuredTelemetryWire.MAX_PACKET_BYTES * 2 || hex.length % 2 != 0) return null
        fun nibble(character: Char): Int? = when (character) {
            in '0'..'9' -> character.code - '0'.code
            in 'a'..'f' -> character.code - 'a'.code + 10
            else -> null
        }
        val output = ByteArray(hex.length / 2)
        for (offset in output.indices) {
            val high = nibble(hex[offset * 2]) ?: return null
            val low = nibble(hex[offset * 2 + 1]) ?: return null
            output[offset] = (high * 16 + low).toByte()
        }
        return output
    }
    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val result = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            val number = byte.toInt() and 255
            result.append(digits[number ushr 4]); result.append(digits[number and 15])
        }
        return result.toString()
    }
    private fun reading(fields: List<String>): ReadingRecord? {
        if (fields.size != 3) return null
        val step = fields[0].toDoubleOrNull() ?: return null
        val mode = ReadingMode.entries.firstOrNull { it.wireName == fields[1] } ?: return null
        val ready: Boolean? = when (fields[2]) { "-" -> null; "0" -> false; "1" -> true; else -> return null }
        return ReadingRecord(step, mode, ready)
    }
    private fun encodingInput(fields: List<String>): StructuredTelemetrySample? {
        if (fields.size < 7 || fields[0] != "E") return null
        val slot = fields[2].toIntOrNull() ?: return null
        val sequence = fields[3].toLongOrNull() ?: return null
        val capturedAt = fields[4].toDoubleOrNull() ?: return null
        val value: ReadingValue
        if (fields[5] == "R" && fields.size == 9) {
            value = ReadingValue.Record(reading(fields.subList(6, 9)) ?: return null)
        } else if (fields[5] == "T") {
            val count = fields[6].toIntOrNull() ?: return null
            if (count !in 1..8 || fields.size != 7 + count * 3) return null
            val rows = ArrayList<ReadingRecord>(count)
            for (index in 0 until count) {
                val start = 7 + index * 3
                rows.add(reading(fields.subList(start, start + 3)) ?: return null)
            }
            value = ReadingValue.Table(rows.toList())
        } else return null
        return StructuredTelemetrySample(fields[1], slot, sequence, capturedAt, value)
    }
    private fun result(sample: StructuredTelemetrySample?): String {
        if (sample == null) return "null"
        return try {
            val encoded = StructuredTelemetryWire.encode(sample)
            val packet = JsonReader(StringReader(String(encoded, StandardCharsets.UTF_8))).use { reader ->
                reader.setStrictness(Strictness.STRICT)
                val parsed = elementAdapter.read(reader)
                if (reader.peek() != JsonToken.END_DOCUMENT || parsed == null || !parsed.isJsonObject) return "null"
                parsed
            }
            val output = JsonObject().apply { addProperty("hex", hex(encoded)); add("packet", packet) }
            gson.toJson(output)
        } catch (_: Exception) { "null" }
    }
    private fun command(line: ByteArray): String {
        if (line.any { (it.toInt() and 255) !in 32..126 }) return "null"
        val fields = String(line, StandardCharsets.US_ASCII).split(' ').filter { it.isNotEmpty() }
        if (fields.size == 3 && fields[0] == "D") {
            val lane = TelemetryLane.entries.firstOrNull { it.wireName == fields[1] } ?: return "null"
            val data = bytes(fields[2]) ?: return "null"
            return result(StructuredTelemetryWire.decode(data, lane))
        }
        return result(encodingInput(fields))
    }

    // The executable and direct stream tests use the same framing path. Streams remain host-owned.
    internal fun run(input: InputStream, output: OutputStream) {
        val chunk = ByteArray(4096)
        val line = ByteArrayOutputStream()
        var commands = 0
        var inputBytes = 0
        var outputBytes = 0
        while (true) {
            val count = input.read(chunk)
            if (count == -1) break
            if (count <= 0) throw FramingException()
            inputBytes += count
            if (inputBytes > MAX_TOTAL_BYTES) throw FramingException()
            for (index in 0 until count) {
                val byte = chunk[index].toInt() and 255
                if (byte == 10) {
                    commands++
                    if (commands > MAX_COMMANDS) throw FramingException()
                    val reply = (command(line.toByteArray()) + "\n").toByteArray(StandardCharsets.UTF_8)
                    outputBytes += reply.size
                    if (outputBytes > MAX_TOTAL_BYTES) throw FramingException()
                    output.write(reply)
                    if (output is PrintStream && output.checkError()) throw FramingException()
                    line.reset()
                } else {
                    if (line.size() >= MAX_LINE_BYTES) throw FramingException()
                    line.write(byte)
                }
            }
        }
        if (line.size() != 0) throw FramingException()
        output.flush()
        if (output is PrintStream && output.checkError()) throw FramingException()
    }

    @JvmStatic fun main(args: Array<String>) {
        if (args.isNotEmpty()) exitProcess(2)
        try { run(System.`in`, System.out) } catch (_: Exception) { exitProcess(2) }
    }
}
