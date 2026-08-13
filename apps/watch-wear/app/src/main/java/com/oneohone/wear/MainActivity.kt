package com.oneohone.wear

import android.app.Activity
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.widget.Button
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The whole Wear OS UI.
 *
 * A watch screen is small and the wearer is looking at the game, not the wrist, so this shows only
 * what the game cannot tell them: whether a route exists, whether it is genuinely local, and a
 * control to start or stop relaying.
 *
 * The locality line is deliberately blunt. When the Data Layer gives a connected-but-not-nearby
 * node, the wearer is told the path may be routed rather than being shown a reassuring green light
 * that 101 cannot actually justify.
 */
class MainActivity : Activity() {
    private lateinit var relay: DataLayerRelay
    private lateinit var motion: MotionSource
    private lateinit var statusText: TextView
    private lateinit var localityText: TextView
    private lateinit var noteText: TextView
    private lateinit var toggle: Button

    private val scope = CoroutineScope(Dispatchers.Main)
    private var refreshJob: Job? = null
    private var relaying = false
    private var crown = 0f
    private var startedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        relay = DataLayerRelay(this)
        motion = MotionSource(this)

        statusText = findViewById(R.id.status)
        localityText = findViewById(R.id.locality)
        noteText = findViewById(R.id.note)
        toggle = findViewById(R.id.toggle)

        toggle.setOnClickListener { if (relaying) stopRelay() else startRelay() }

        // Rotary bezel and crown input, the Wear OS counterpart of the Digital Crown.
        findViewById<android.view.View>(R.id.root).apply {
            requestFocus()
            setOnGenericMotionListener { _, event ->
                if (event.action == MotionEvent.ACTION_SCROLL && event.isFromSource(InputDevice.SOURCE_ROTARY_ENCODER)) {
                    crown += event.getAxisValue(MotionEvent.AXIS_SCROLL)
                    true
                } else {
                    false
                }
            }
        }

        motion.onSample = { orientation, acceleration, rotationRate ->
            if (relaying) {
                relay.relay(
                    timestampMs = (SystemClock.elapsedRealtime() - startedAt).toDouble(),
                    orientation = orientation,
                    acceleration = acceleration,
                    rotationRate = rotationRate,
                    crown = crown,
                    tap = false,
                )
                statusText.text = getString(R.string.sent_format, relay.sent, relay.dropped)
            }
        }

        if (!motion.available) {
            toggle.isEnabled = false
            noteText.text = getString(R.string.no_motion_sensor)
        }
    }

    override fun onResume() {
        super.onResume()
        refreshJob = scope.launch {
            while (true) {
                val state = relay.refresh()
                render(state)
                delay(REFRESH_INTERVAL_MS)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        refreshJob?.cancel()
        refreshJob = null
        stopRelay()
    }

    private fun render(state: WearLinkState) {
        localityText.text = state.locality.wireValue.uppercase()
        noteText.text = state.note
        toggle.isEnabled = motion.available && state.canRelayRealtime
        if (!state.canRelayRealtime && relaying) stopRelay()
    }

    private fun startRelay() {
        relaying = true
        startedAt = SystemClock.elapsedRealtime()
        motion.start()
        toggle.setText(R.string.stop)
    }

    private fun stopRelay() {
        if (!relaying) return
        relaying = false
        motion.stop()
        toggle.setText(R.string.start)
    }

    private companion object {
        const val REFRESH_INTERVAL_MS = 2_000L
    }
}
