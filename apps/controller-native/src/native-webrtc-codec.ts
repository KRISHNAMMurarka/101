import {
  createInputPacketProfile,
  deserializeControlMessage,
  deserializeRealtimeMessage,
  INPUT_Q1_FORMAT,
  serializeControlMessage,
  serializeRealtimeMessage,
  type ControlMessage,
  type InputPacketProfile,
  type RealtimeMessage,
} from "@101/protocol";

type PlayerAssignment = Extract<ControlMessage, { type: "player.assign" }>;

interface InputNegotiation {
  assignment?: PlayerAssignment;
  profile?: InputPacketProfile;
}

/**
 * Owns native DataChannel serialization and its deliberately opposite control/input directions.
 * Keeping this RN-free makes the exact production codec executable under Node instead of relying
 * on a source-text assertion that can pass while Link remains on JSON forever.
 */
export class NativeWebRTCCodec {
  private outgoing: InputNegotiation = {};
  private incoming: InputNegotiation = {};

  serializeControl(message: ControlMessage) {
    // Configuration sent to the peer describes input this endpoint will receive and decode.
    this.incoming = observeInputNegotiation(this.incoming, message);
    return serializeControlMessage(message);
  }

  deserializeControl(data: string) {
    const message = deserializeControlMessage(data);
    // Configuration received from the peer describes input this endpoint will send and encode.
    this.outgoing = observeInputNegotiation(this.outgoing, message);
    return message;
  }

  serializeRealtime(message: RealtimeMessage) {
    return serializeRealtimeMessage(message, this.outgoing.profile);
  }

  deserializeRealtime(data: string | ArrayBuffer | ArrayBufferView) {
    return deserializeRealtimeMessage(data, this.incoming.profile);
  }

  reset() {
    this.outgoing = {};
    this.incoming = {};
  }
}

function observeInputNegotiation(current: InputNegotiation, message: ControlMessage): InputNegotiation {
  if (message.type === "player.assign") {
    if (current.assignment?.deviceId === message.deviceId && current.assignment.playerId === message.playerId) {
      return { ...current, assignment: message };
    }
    return { assignment: message };
  }
  if (message.type === "player.wait") {
    return !current.assignment || current.assignment.deviceId === message.deviceId ? {} : current;
  }
  if (message.type !== "controller.configure") return current;
  const assignment = current.assignment;
  const profile = message.inputFormat === INPUT_Q1_FORMAT && assignment?.deviceId === message.deviceId
    ? createInputPacketProfile(message.layout, {
        revision: message.revision,
        deviceId: message.deviceId,
        playerId: assignment.playerId,
      })
    : undefined;
  return { ...current, profile };
}
