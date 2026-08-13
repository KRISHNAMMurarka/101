package com.oneohone.wear

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager

/**
 * Wrist motion capture.
 *
 * Uses the fused `TYPE_ROTATION_VECTOR` for attitude and `TYPE_LINEAR_ACCELERATION` for
 * gravity-removed acceleration, matching what CoreMotion gives the watchOS relay so both platforms
 * feed `@101/motion` the same quantities in the same units.
 *
 * Body sensors are deliberately never requested. 101 reads wrist movement only — no heart rate, no
 * activity recognition, no health data of any kind — so the manifest declares none of those
 * permissions and this class cannot acquire them later.
 */
class MotionSource(context: Context) : SensorEventListener {
    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotation: Sensor? = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val linear: Sensor? = manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val gyroscope: Sensor? = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

    // [x, y, z, w] to match the 101 quaternion convention. Android returns [w, x, y, z].
    private val orientation = floatArrayOf(0f, 0f, 0f, 1f)
    private val acceleration = floatArrayOf(0f, 0f, 0f)
    private val rotationRate = floatArrayOf(0f, 0f, 0f)
    private val quaternion = FloatArray(4)

    val available: Boolean get() = rotation != null

    var onSample: ((FloatArray, FloatArray, FloatArray) -> Unit)? = null

    fun start() {
        // 10 ms gives the relay headroom to pick a clean 50 Hz without aliasing.
        val periodMicros = 10_000
        rotation?.let { manager.registerListener(this, it, periodMicros) }
        linear?.let { manager.registerListener(this, it, periodMicros) }
        gyroscope?.let { manager.registerListener(this, it, periodMicros) }
    }

    fun stop() {
        manager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getQuaternionFromVector(quaternion, event.values)
                orientation[0] = quaternion[1]
                orientation[1] = quaternion[2]
                orientation[2] = quaternion[3]
                orientation[3] = quaternion[0]
            }
            Sensor.TYPE_LINEAR_ACCELERATION -> {
                // Android reports m/s^2; 101 and CoreMotion both work in g.
                for (index in 0..2) acceleration[index] = event.values[index] / GRAVITY
            }
            Sensor.TYPE_GYROSCOPE -> {
                // Android reports rad/s; 101 thresholds are in degrees/second.
                for (index in 0..2) rotationRate[index] = Math.toDegrees(event.values[index].toDouble()).toFloat()
            }
            else -> return
        }
        onSample?.invoke(orientation.copyOf(), acceleration.copyOf(), rotationRate.copyOf())
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val GRAVITY = 9.80665f
    }
}
