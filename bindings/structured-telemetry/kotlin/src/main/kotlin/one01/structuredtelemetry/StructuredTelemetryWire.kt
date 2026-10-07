package one01.structuredtelemetry

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

enum class TelemetryLane(val wireName: String) { RELIABLE("reliable"), DISPOSABLE("disposable") }
enum class ReadingMode(val wireName: String) { COUNT_UP("count-up"), COUNT_DOWN("count-down") }
class StructuredTelemetryWireException : IllegalArgumentException("invalid")

/** Selected app:page-reading/1. Step is a finite quantity in unit 1. */
data class ReadingRecord(val step: Double, val mode: ReadingMode, val ready: Boolean? = null)
sealed interface ReadingValue {
    data class Record(val reading: ReadingRecord) : ReadingValue
    data class Table(val rows: List<ReadingRecord>) : ReadingValue
}

/** Source time is preserved. The host owns slot/schema selection, clocks, freshness and authority. */
data class StructuredTelemetrySample(
    val epoch: String,
    val slot: Int,
    val sequence: Long,
    val capturedAt: Double,
    val value: ReadingValue
)

/** Inert UTF-8 json/2 codec for two selected schemas. No transport, grants or lifecycle is created. */
object StructuredTelemetryWire {
    const val MAX_PACKET_BYTES = 4096
    private const val MAX_CONTAINER_DEPTH = 3
    private const val MAX_SEQUENCE = 4294967295L
    private val envelopeFields = setOf("protocol", "version", "type", "epoch", "slot", "sequence", "capturedAt", "value")
    private val recordFields = setOf("step", "mode", "ready")
    // Gson 2.11.0 is an explicit installed runtime dependency. Default lenient parsing is not used.
    private val gson = GsonBuilder().setStrictness(Strictness.STRICT).disableHtmlEscaping().create()
    private val elementAdapter = gson.getAdapter(JsonElement::class.java)

    private fun validEpoch(epoch: String): Boolean =
        epoch.length == 32 && epoch.all { it in '0'..'9' || it in 'a'..'f' }
    private fun valid(reading: ReadingRecord): Boolean = reading.step.isFinite() && reading.step in 0.0..100.0
    private fun valid(sample: StructuredTelemetrySample): Boolean {
        if (!validEpoch(sample.epoch) || sample.slot !in 1..128 || sample.sequence !in 1..MAX_SEQUENCE ||
            !sample.capturedAt.isFinite() || sample.capturedAt < 0.0) return false
        return when (val value = sample.value) {
            is ReadingValue.Record -> valid(value.reading)
            is ReadingValue.Table -> value.rows.size in 1..8 && value.rows.all { valid(it) }
        }
    }

    // Only a byte/encoding/depth preflight. Gson implements the complete JSON grammar.
    private fun utf8Envelope(data: ByteArray): String? {
        if (data.isEmpty() || data.size > MAX_PACKET_BYTES) return null
        for (index in 0 until data.size - 2) {
            if ((data[index].toInt() and 255) == 239 && (data[index + 1].toInt() and 255) == 187 &&
                (data[index + 2].toInt() and 255) == 191) return null
        }
        val text = try {
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString()
        } catch (_: Exception) { return null }
        if ('\uFEFF' in text) return null
        var depth = 0
        var quoted = false
        var escaped = false
        for (raw in data) {
            val byte = raw.toInt() and 255
            if (byte < 32 && (quoted || (byte != 9 && byte != 10 && byte != 13))) return null
            if (byte == 127) return null
            if (quoted) {
                if (escaped) escaped = false
                else if (byte == 92) escaped = true
                else if (byte == 34) quoted = false
                continue
            }
            when (byte) {
                34 -> quoted = true
                123, 91 -> { depth++; if (depth > MAX_CONTAINER_DEPTH) return null }
                125, 93 -> { if (depth <= 0) return null; depth-- }
            }
        }
        return if (depth == 0 && !quoted && !escaped) text else null
    }

    private fun number(input: JsonElement?): Double? {
        if (input == null || !input.isJsonPrimitive || !input.asJsonPrimitive.isNumber) return null
        val result = input.asDouble
        return if (result.isFinite()) result else null
    }
    private fun text(input: JsonElement?): String? {
        if (input == null || !input.isJsonPrimitive || !input.asJsonPrimitive.isString) return null
        return input.asString
    }
    private fun integer(input: JsonElement?, max: Long): Long? {
        val number = number(input) ?: return null
        if (number < 1.0 || number > max.toDouble() || number % 1.0 != 0.0) return null
        return number.toLong()
    }
    private fun reading(input: JsonElement): ReadingRecord? {
        if (!input.isJsonObject) return null
        val fields = input.asJsonObject
        if (fields.size() !in 2..3 || fields.keySet().any { it !in recordFields }) return null
        val step = number(fields["step"]) ?: return null
        if (step !in 0.0..100.0) return null
        val modeText = text(fields["mode"]) ?: return null
        val mode = ReadingMode.entries.firstOrNull { it.wireName == modeText } ?: return null
        var ready: Boolean? = null
        if (fields.has("ready")) {
            val supplied = fields["ready"]
            if (!supplied.isJsonPrimitive || !supplied.asJsonPrimitive.isBoolean) return null
            ready = supplied.asBoolean
        }
        return ReadingRecord(step, mode, ready)
    }
    private fun readingValue(input: JsonElement): ReadingValue? {
        reading(input)?.let { return ReadingValue.Record(it) }
        if (!input.isJsonArray || input.asJsonArray.size() !in 1..8) return null
        val rows = ArrayList<ReadingRecord>(input.asJsonArray.size())
        for (entry in input.asJsonArray) rows.add(reading(entry) ?: return null)
        return ReadingValue.Table(rows.toList())
    }
    private fun objectValue(reading: ReadingRecord): JsonObject = JsonObject().apply {
        // Match JSON.stringify's normalization of negative zero in public SDK producer bytes.
        addProperty("step", if (reading.step == 0.0) 0.0 else reading.step)
        addProperty("mode", reading.mode.wireName)
        reading.ready?.let { addProperty("ready", it) }
    }
    private fun objectValue(value: ReadingValue): JsonElement = when (value) {
        is ReadingValue.Record -> objectValue(value.reading)
        is ReadingValue.Table -> JsonArray().apply { value.rows.forEach { add(objectValue(it)) } }
    }

    fun encode(sample: StructuredTelemetrySample): ByteArray {
        val captured = try {
            when (val value = sample.value) {
                is ReadingValue.Record -> sample
                is ReadingValue.Table -> {
                    val count = value.rows.size
                    if (count !in 1..8) throw StructuredTelemetryWireException()
                    sample.copy(value = ReadingValue.Table(List(count) { value.rows[it] }))
                }
            }
        } catch (_: Exception) { throw StructuredTelemetryWireException() }
        if (!valid(captured)) throw StructuredTelemetryWireException()
        val fields = JsonObject().apply {
            addProperty("protocol", "connect"); addProperty("version", 2); addProperty("type", "sample")
            addProperty("epoch", captured.epoch); addProperty("slot", captured.slot); addProperty("sequence", captured.sequence)
            addProperty("capturedAt", if (captured.capturedAt == 0.0) 0.0 else captured.capturedAt)
            add("value", objectValue(captured.value))
        }
        val data = gson.toJson(fields).toByteArray(StandardCharsets.UTF_8)
        if (utf8Envelope(data) == null) throw StructuredTelemetryWireException()
        return data
    }

    fun decode(data: ByteArray, lane: TelemetryLane): StructuredTelemetrySample? {
        if (lane != TelemetryLane.DISPOSABLE || data.isEmpty() || data.size > MAX_PACKET_BYTES) return null
        // Both the raw preflight and the parser inspect the same bounded owned bytes.
        val utf8 = utf8Envelope(data.copyOf()) ?: return null
        return try {
            JsonReader(StringReader(utf8)).use { reader ->
                reader.setStrictness(Strictness.STRICT)
                val parsed = elementAdapter.read(reader)
                if (reader.peek() != JsonToken.END_DOCUMENT || parsed == null || !parsed.isJsonObject) return null
                val fields = parsed.asJsonObject
                if (fields.keySet() != envelopeFields || text(fields["protocol"]) != "connect" ||
                    text(fields["type"]) != "sample" || number(fields["version"]) != 2.0) return null
                val epoch = text(fields["epoch"]) ?: return null
                if (!validEpoch(epoch)) return null
                val slot = integer(fields["slot"], 128) ?: return null
                val sequence = integer(fields["sequence"], MAX_SEQUENCE) ?: return null
                val capturedAt = number(fields["capturedAt"]) ?: return null
                if (capturedAt < 0.0) return null
                val value = readingValue(fields["value"]) ?: return null
                StructuredTelemetrySample(epoch, slot.toInt(), sequence, capturedAt, value)
            }
        } catch (_: Exception) { null }
    }
}
