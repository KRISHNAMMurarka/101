function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error('mqtt-profile-frame');
  return value;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }

/** Fixed reviewed decoder for the example's one-output-per-topic MQTT JSON payloads. */
export function createMqttExampleDecoder() {
  return {
    decode(bytes, context) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4096) throw Error('mqtt-profile-size');
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (input?.kind === 'ack') {
        const frame = closed(input, ['kind', 'resourceId', 'commandId', 'sequence', 'sourceTime']);
        const sourceTime = closed(frame.sourceTime, ['clockId', 'at']);
        if (frame.resourceId !== 'set-enabled' || !/^[1-9][0-9]{0,15}$/.test(frame.commandId) || !positive(frame.sequence) ||
          sourceTime.clockId !== context.clockId || !Number.isFinite(sourceTime.at) || sourceTime.at < 0) throw Error('mqtt-profile-ack');
        return [{ kind: 'ack', resourceId: frame.resourceId, commandId: frame.commandId, sequence: frame.sequence, sourceTime }];
      }
      const frame = closed(input, ['kind', 'resourceId', 'value', 'sequence', 'sourceTime', 'quality', 'calibration']);
      const sourceTime = closed(frame.sourceTime, ['clockId', 'at']);
      if (frame.kind !== 'sample' || !['temperature', 'enabled'].includes(frame.resourceId) || !positive(frame.sequence) ||
        sourceTime.clockId !== context.clockId || !Number.isFinite(sourceTime.at) || sourceTime.at < 0 || frame.quality !== 'valid') throw Error('mqtt-profile-sample');
      if (frame.resourceId === 'temperature' && (typeof frame.value !== 'number' || frame.value < -40 || frame.value > 125 ||
        !frame.calibration || frame.calibration.revision !== 1 || frame.calibration.unit !== 'Cel' || frame.calibration.absoluteErrorBound !== 0.5)) throw Error('mqtt-profile-temperature');
      if (frame.resourceId === 'enabled' && (typeof frame.value !== 'boolean' || frame.calibration !== null)) throw Error('mqtt-profile-state');
      return [{ kind: 'sample', resourceId: frame.resourceId, value: frame.value, sequence: frame.sequence,
        sourceTime, quality: 'valid', calibration: frame.calibration }];
    },
    encodeCommand(input) {
      const value = closed(input, ['resourceId', 'commandId', 'value']);
      if (value.resourceId !== 'set-enabled' || typeof value.value !== 'boolean' || !/^[1-9][0-9]{0,15}$/.test(value.commandId)) throw Error('mqtt-profile-command');
      return new TextEncoder().encode(`${JSON.stringify({ wireVersion: 1, kind: 'command', ...value })}\n`);
    },
    reset() {},
  };
}
