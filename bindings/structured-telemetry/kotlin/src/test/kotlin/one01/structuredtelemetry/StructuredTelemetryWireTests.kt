package one01.structuredtelemetry

import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.PrintStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

// Authored before the codec/caller. UNRUN: root owns actual compiler and SDK reciprocal execution.
// An empty decoder, boolean/number coercion, open schemas or framing bypass must fail these checks.
object StructuredTelemetryWireTests {
    private const val epoch = "0123456789abcdef0123456789abcdef"
    private val json = GsonBuilder().setStrictness(Strictness.STRICT).serializeNulls().create()
    private var checks = 0

    private fun expect(condition: Boolean, label: String) {
        checks++
        check(condition) { label }
    }
    private fun sample(value: ReadingValue, slot: Int = 1, sequence: Long = 1,
                       capturedAt: Double = 0.0, selectedEpoch: String = epoch) =
        StructuredTelemetrySample(selectedEpoch, slot, sequence, capturedAt, value)
    private fun row(step: Double = 0.0, mode: ReadingMode = ReadingMode.COUNT_UP, ready: Boolean? = null) =
        ReadingRecord(step, mode, ready)
    private fun bytes(value: JsonElement) = json.toJson(value).toByteArray(StandardCharsets.UTF_8)
    private fun objectValue(input: ByteArray): JsonObject =
        json.fromJson(String(input, StandardCharsets.UTF_8), JsonObject::class.java)

    // These are root's genuine installed @101/connect fixture bytes, not codec-generated input.
    private fun actualPackets(): Map<String, ByteArray> {
        val path = System.getenv("ONE01_STRUCTURED_FIXTURES") ?: error("missing actual SDK fixtures")
        val input = Files.newInputStream(Path.of(path)).use { it.readNBytes(131073) }
        expect(input.size <= 131072, "fixture bytes bounded")
        val document = objectValue(input)
        expect(document["profile"].asString == "structured-telemetry-json2/1", "fixture profile")
        expect(document["status"].asString == "pass", "fixture producer settled")
        val entries = document["positive"].asJsonArray
        expect(entries.size() == 5, "all selected actual fixture specimens")
        val packets = linkedMapOf<String, ByteArray>()
        for (entry in entries) {
            val fields = entry.asJsonObject
            val id = fields["id"].asString
            expect(!packets.containsKey(id), "unique actual fixture ids")
            val wire = fields["wireUtf8"].asString.toByteArray(StandardCharsets.UTF_8)
            expect(wire.size == fields["bytes"].asInt, "actual fixture byte count")
            packets[id] = wire
        }
        return packets
    }

    private fun genuineSdkBytesPreserveSelectedFields(packets: Map<String, ByteArray>) {
        val expected = mapOf(
            "record-absent" to sample(ReadingValue.Record(row())),
            "record-false" to sample(ReadingValue.Record(row(50.25, ReadingMode.COUNT_DOWN, false)),
                                      128, 4294967295L, 125.5),
            "record-true" to sample(ReadingValue.Record(row(100.0, ready = true)), 2, 4, 9007199254740991.0),
            "one-row" to sample(ReadingValue.Table(listOf(row(1.0, ready = false))), 1, 6, 1400.25),
            "eight-rows" to sample(ReadingValue.Table(listOf(
                row(), row(12.5, ReadingMode.COUNT_DOWN, false), row(25.0, ready = true),
                row(37.5, ReadingMode.COUNT_DOWN), row(50.0, ready = true),
                row(62.5, ReadingMode.COUNT_DOWN, false), row(75.0), row(87.5, ReadingMode.COUNT_DOWN, false)
            )), 128, 32, 1500.125)
        )
        expect(packets.keys == expected.keys, "complete expected fixture identities")
        for ((id, input) in packets) {
            val decoded = StructuredTelemetryWire.decode(input, TelemetryLane.DISPOSABLE)
            expect(decoded == expected[id], "actual fixture field preservation: $id")
            expect(StructuredTelemetryWire.decode(input, TelemetryLane.RELIABLE) == null, "reliable lane rejected")
            val encoded = StructuredTelemetryWire.encode(checkNotNull(decoded))
            expect(encoded.size <= 4096, "encoded packet bytes bounded")
            expect(objectValue(encoded) == objectValue(input), "reciprocal JSON meaning: $id")
            expect(StructuredTelemetryWire.decode(encoded, TelemetryLane.DISPOSABLE) == expected[id], "typed roundtrip: $id")
        }
    }

    private fun absentAndFalseRemainDistinct() {
        val absent = objectValue(StructuredTelemetryWire.encode(sample(ReadingValue.Record(row(5.0, ReadingMode.COUNT_DOWN)))))
        val supplied = objectValue(StructuredTelemetryWire.encode(sample(ReadingValue.Record(row(5.0, ReadingMode.COUNT_DOWN, false)))))
        expect(!absent["value"].asJsonObject.has("ready"), "absent ready remains absent")
        expect(supplied["value"].asJsonObject["ready"].asJsonPrimitive.isBoolean, "false keeps boolean type")
        expect(!supplied["value"].asJsonObject["ready"].asBoolean, "false ready not omitted")
    }

    private fun closedHeadersRejectCoercion(base: JsonObject) {
        val replacements = listOf(
            "protocol" to JsonPrimitive("other"), "version" to JsonPrimitive(1), "version" to JsonPrimitive(true),
            "type" to JsonPrimitive("event"), "type" to JsonPrimitive("clock"),
            "epoch" to JsonPrimitive(epoch.uppercase()), "epoch" to JsonPrimitive("short"),
            "epoch" to JsonPrimitive("g".repeat(32)), "slot" to JsonPrimitive(0), "slot" to JsonPrimitive(129),
            "slot" to JsonPrimitive(1.5), "slot" to JsonPrimitive(true), "slot" to JsonPrimitive("1"),
            "sequence" to JsonPrimitive(0), "sequence" to JsonPrimitive(4294967296L),
            "sequence" to JsonPrimitive(1.5), "sequence" to JsonPrimitive(false),
            "capturedAt" to JsonPrimitive(-1), "capturedAt" to JsonPrimitive(true),
            "capturedAt" to JsonPrimitive("0"), "value" to JsonNull.INSTANCE
        )
        for ((key, value) in replacements) {
            val bad = base.deepCopy(); bad.add(key, value)
            expect(StructuredTelemetryWire.decode(bytes(bad), TelemetryLane.DISPOSABLE) == null, "invalid header: $key")
        }
        for (key in base.keySet()) {
            val bad = base.deepCopy(); bad.remove(key)
            expect(StructuredTelemetryWire.decode(bytes(bad), TelemetryLane.DISPOSABLE) == null, "missing header: $key")
        }
        val extra = base.deepCopy(); extra.addProperty("clockId", "invented-clock")
        expect(StructuredTelemetryWire.decode(bytes(extra), TelemetryLane.DISPOSABLE) == null, "closed header")
    }

    private fun selectedSchemasRejectMalformedValues(base: JsonObject) {
        val invalidRows = listOf(
            "{\"step\":true,\"mode\":\"count-up\"}", "{\"step\":\"5\",\"mode\":\"count-up\"}",
            "{\"step\":-0.1,\"mode\":\"count-up\"}", "{\"step\":100.1,\"mode\":\"count-up\"}",
            "{\"step\":null,\"mode\":\"count-up\"}", "{\"step\":0}", "{\"mode\":\"count-up\"}",
            "{\"step\":0,\"mode\":\"up\"}", "{\"step\":0,\"mode\":null}",
            "{\"step\":0,\"mode\":\"count-up\",\"ready\":0}", "{\"step\":0,\"mode\":\"count-up\",\"ready\":1}",
            "{\"step\":0,\"mode\":\"count-up\",\"ready\":\"false\"}",
            "{\"step\":0,\"mode\":\"count-up\",\"ready\":null}", "{\"step\":0,\"mode\":\"count-up\",\"extra\":false}"
        )
        val validRow = "{\"step\":0,\"mode\":\"count-up\"}"
        val invalidValues = invalidRows.flatMap { listOf(it, "[$it]") } + listOf(
            "[]", "[" + List(9) { validRow }.joinToString(",") + "]", "[null]", "[[$validRow]]", "true", "\"value\""
        )
        for (input in invalidValues) {
            val bad = base.deepCopy(); bad.add("value", json.fromJson(input, JsonElement::class.java))
            expect(StructuredTelemetryWire.decode(bytes(bad), TelemetryLane.DISPOSABLE) == null, "selected schema rejects malformed value")
        }
    }

    private fun rawUtf8DepthAndStrictGrammar(original: ByteArray) {
        val text = String(original, StandardCharsets.UTF_8)
        val padded = original + ByteArray(4096 - original.size) { 32 }
        expect(StructuredTelemetryWire.decode(padded, TelemetryLane.DISPOSABLE) != null, "4096 byte inclusive limit")
        expect(StructuredTelemetryWire.decode(padded + byteArrayOf(32), TelemetryLane.DISPOSABLE) == null, "4097 byte rejected")
        for (encoding in listOf(StandardCharsets.UTF_16, StandardCharsets.UTF_16LE, StandardCharsets.UTF_16BE)) {
            expect(StructuredTelemetryWire.decode(text.toByteArray(encoding), TelemetryLane.DISPOSABLE) == null, "UTF16 rejected")
        }
        for (prefix in listOf(byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()), byteArrayOf(0),
                              byteArrayOf(31), byteArrayOf(127), byteArrayOf(0xc0.toByte(), 0xaf.toByte()))) {
            expect(StructuredTelemetryWire.decode(prefix + original, TelemetryLane.DISPOSABLE) == null, "BOM/control/invalid UTF8 rejected")
        }
        val afterWhitespace = byteArrayOf(32, 9, 0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) + original
        expect(StructuredTelemetryWire.decode(afterWhitespace, TelemetryLane.DISPOSABLE) == null, "BOM after whitespace rejected")
        expect(StructuredTelemetryWire.decode("\t\r\n $text \n".toByteArray(), TelemetryLane.DISPOSABLE) != null, "JSON whitespace allowed")
        expect(StructuredTelemetryWire.decode(text.replace("count-up", "count\\u002dup").toByteArray(), TelemetryLane.DISPOSABLE) != null, "JSON escape interpreted by parser")
        val invalidText = listOf(
            text.replace("\"capturedAt\":0", "\"capturedAt\":1e309"),
            text.replace("\"value\":{\"step\":0,\"mode\":\"count-up\"}", "\"value\":[[[[[0]]]]]"),
            "{\"value\":\"unterminated", "$text $text", "/*comment*/$text",
            text.replace("\"protocol\"", "protocol"), text.replace("\"connect\"", "'connect'"),
            text.dropLast(1) + ",}", text.replace("\"capturedAt\":0", "\"capturedAt\":NaN"),
            text.replace("count-up", "count\u0001up")
        )
        for (input in invalidText) expect(StructuredTelemetryWire.decode(input.toByteArray(), TelemetryLane.DISPOSABLE) == null, "strict JSON/finite/depth rejection")
        expect(StructuredTelemetryWire.decode(byteArrayOf(), TelemetryLane.DISPOSABLE) == null, "empty input rejected")
    }

    private fun typedEncodeRejectsInvalidSamples() {
        val record = ReadingValue.Record(row())
        val invalid = mutableListOf(
            sample(record, selectedEpoch = ""), sample(record, selectedEpoch = epoch.uppercase()),
            sample(record, slot = 0), sample(record, slot = 129), sample(record, sequence = 0),
            sample(record, sequence = 4294967296L), sample(ReadingValue.Table(emptyList())),
            sample(ReadingValue.Table(List(9) { row() }))
        )
        for (time in listOf(-1.0, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) invalid += sample(record, capturedAt = time)
        for (step in listOf(-0.1, 100.1, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) invalid += sample(ReadingValue.Record(row(step)))
        for (input in invalid) {
            var rejected = false
            try { StructuredTelemetryWire.encode(input) } catch (error: StructuredTelemetryWireException) { rejected = error.message == "invalid" }
            expect(rejected, "invalid typed sample rejected without payload diagnostics")
        }
        val large = sample(ReadingValue.Record(row(100.0, ready = true)), capturedAt = 1e300)
        expect(StructuredTelemetryWire.decode(StructuredTelemetryWire.encode(large), TelemetryLane.DISPOSABLE) == large, "large finite source time preserved")
        val zero = objectValue(StructuredTelemetryWire.encode(sample(ReadingValue.Record(row(-0.0)), capturedAt = -0.0)))
        expect(zero["capturedAt"].asDouble.toRawBits() == 0.0.toRawBits(), "source negative zero normalized as JSON.stringify")
        expect(zero["value"].asJsonObject["step"].asDouble.toRawBits() == 0.0.toRawBits(), "quantity negative zero normalized")
    }

    private fun capturesBoundedBorrowedRows(packets: Map<String, ByteArray>) {
        val prefix = checkNotNull(StructuredTelemetryWire.decode(packets.getValue("record-absent"), TelemetryLane.DISPOSABLE))
        var reads = 0
        val borrowed = object : AbstractList<ReadingRecord>() {
            override val size: Int get() = 1
            override fun get(index: Int): ReadingRecord { check(index == 0); return row(if (reads++ == 0) 0.0 else 200.0) }
        }
        val stable = StructuredTelemetryWire.decode(StructuredTelemetryWire.encode(prefix.copy(value = ReadingValue.Table(borrowed))), TelemetryLane.DISPOSABLE)
        expect(stable?.value == ReadingValue.Table(listOf(row())), "table serialization uses captured validated rows")
        expect(reads == 1, "each selected borrowed row captured once")
        var oversizedReads = 0
        val oversized = object : AbstractList<ReadingRecord>() {
            override val size: Int get() = 9
            override fun get(index: Int): ReadingRecord { oversizedReads++; return row() }
        }
        var rejected = false
        try { StructuredTelemetryWire.encode(prefix.copy(value = ReadingValue.Table(oversized))) }
        catch (error: StructuredTelemetryWireException) { rejected = error.message == "invalid" }
        expect(rejected && oversizedReads == 0, "oversized table rejected before copying rows")
    }

    private fun actualPrintStreamFailureCannotReturnSuccess() {
        val output = PrintStream(object : OutputStream() { override fun write(byte: Int) { throw IOException("owned output refused") } }, false, StandardCharsets.UTF_8)
        var rejected = false
        try { StructuredTelemetryConsumer.run(ByteArrayInputStream("?\n".toByteArray()), output) }
        catch (_: Exception) { rejected = true }
        expect(output.checkError(), "actual standard JDK PrintStream reports swallowed IOException")
        expect(rejected, "caller must reject output failure")
    }

    private fun callerFramingAndRealDecode(packets: Map<String, ByteArray>) {
        val hex = packets.getValue("record-false").joinToString("") { "%02x".format(it.toInt() and 255) }
        val tableHex = packets.getValue("one-row").joinToString("") { "%02x".format(it.toInt() and 255) }
        val commands = "D disposable $hex\nE $epoch 128 4294967295 125.5 R 50.25 count-down 0\n" +
            "D disposable $tableHex\nE $epoch 1 6 1400.25 T 1 1 count-up 0\n" +
            "D reliable $hex\nD disposable ff\nE $epoch 1 1 0 R NaN count-up -\n"
        val output = ByteArrayOutputStream()
        StructuredTelemetryConsumer.run(ByteArrayInputStream(commands.toByteArray()), output)
        val lines = output.toString(StandardCharsets.UTF_8).trimEnd().split('\n')
        expect(lines.size == 7, "one result per command")
        val original = objectValue(packets.getValue("record-false"))
        for (line in lines.take(2)) {
            val result = json.fromJson(line, JsonObject::class.java)
            expect(result["packet"] == original, "ordinary caller preserves source meaning")
            expect(result["hex"].asString.length <= 8192, "ordinary caller hex bounded")
        }
        for (line in lines.subList(2, 4)) {
            val result = json.fromJson(line, JsonObject::class.java)
            expect(result["packet"] == objectValue(packets.getValue("one-row")), "ordinary caller table encode/decode")
        }
        expect(lines.drop(4) == listOf("null", "null", "null"), "ordinary caller malformed/lane results redact errors")
        fun rejects(input: ByteArray): Boolean = try {
            StructuredTelemetryConsumer.run(ByteArrayInputStream(input), ByteArrayOutputStream()); false
        } catch (_: Exception) { true }
        expect(rejects("D disposable ff".toByteArray()), "unterminated command rejected")
        expect(rejects(("?\n".repeat(129)).toByteArray()), "129th command rejected")
        expect(rejects(("?".repeat(16385) + "\n").toByteArray()), "overlong line rejected")
        val fullPacket = packets.getValue("record-absent") + ByteArray(4096 - packets.getValue("record-absent").size) { 32 }
        val fullHex = fullPacket.joinToString("") { "%02x".format(it.toInt() and 255) }
        expect(rejects(("D disposable $fullHex\n".repeat(128)).toByteArray()), "total input bytes bounded across valid lines")
        val bounded = ByteArrayOutputStream()
        StructuredTelemetryConsumer.run(ByteArrayInputStream(("?\n".repeat(128)).toByteArray()), bounded)
        expect(bounded.toString(StandardCharsets.UTF_8).split('\n').count { it == "null" } == 128, "128 commands supported")
        val nonAscii = ByteArrayOutputStream()
        StructuredTelemetryConsumer.run(ByteArrayInputStream(byteArrayOf(0xff.toByte(), 10)), nonAscii)
        expect(nonAscii.toString(StandardCharsets.UTF_8) == "null\n", "nonASCII caller framing redacted")
    }

    @JvmStatic fun main(args: Array<String>) {
        expect(args.isEmpty(), "test entry point takes no unqualified fixture substitution")
        val packets = actualPackets()
        genuineSdkBytesPreserveSelectedFields(packets)
        absentAndFalseRemainDistinct()
        val base = objectValue(packets.getValue("record-absent"))
        closedHeadersRejectCoercion(base)
        selectedSchemasRejectMalformedValues(base)
        rawUtf8DepthAndStrictGrammar(packets.getValue("record-absent"))
        typedEncodeRejectsInvalidSamples()
        capturesBoundedBorrowedRows(packets)
        actualPrintStreamFailureCannotReturnSuccess()
        callerFramingAndRealDecode(packets)
        println("structured-telemetry Kotlin checks: $checks")
    }
}
