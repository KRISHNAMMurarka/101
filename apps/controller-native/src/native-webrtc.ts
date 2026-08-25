import {
  RTCPeerConnection,
  RTCSessionDescription,
} from "react-native-webrtc";

import {
  type ControlMessage,
  type LinkMessage,
  type LinkState,
  type RealtimeMessage,
} from "@101/protocol";
import type { NegotiatedLinkTransport } from "@101/pairing";
import { NativeWebRTCCodec } from "./native-webrtc-codec";
import { decodeDescription, encodeDescription } from "./pairing-code";

type NativeDataChannel = ReturnType<RTCPeerConnection["createDataChannel"]>;

export class NativeWebRTCTransport implements NegotiatedLinkTransport {
  private peer?: RTCPeerConnection;
  private control?: NativeDataChannel;
  private realtime?: NativeDataChannel;
  private readonly listeners = new Set<(message: LinkMessage) => void>();
  private readonly stateListeners = new Set<(state: LinkState) => void>();
  private currentState: LinkState = "idle";
  private readonly codec = new NativeWebRTCCodec();

  get state() {
    return this.currentState;
  }

  async connect() {
    if (this.peer) return;
    this.setState("connecting");
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") this.setState("failed");
      if (peer.connectionState === "disconnected" || peer.connectionState === "closed") {
        this.setState("disconnected");
      }
    };
    peer.ondatachannel = (event: unknown) => this.attach((event as { channel: NativeDataChannel }).channel);
  }

  async disconnect() {
    this.control?.close();
    this.realtime?.close();
    this.peer?.close();
    this.control = undefined;
    this.realtime = undefined;
    this.peer = undefined;
    this.codec.reset();
    this.setState("disconnected");
  }

  async createOfferCode() {
    await this.connect();
    const peer = this.requirePeer();
    this.attach(peer.createDataChannel("101-control", { ordered: true }));
    this.attach(peer.createDataChannel("101-realtime", { ordered: false, maxRetransmits: 0 }));
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer);
    return encodeDescription(localDescription(peer));
  }

  async acceptOfferCode(code: string) {
    await this.connect();
    const peer = this.requirePeer();
    const offer = decodeDescription(code);
    if (offer.type !== "offer") throw new Error("Expected a 101 WebRTC offer");
    await peer.setRemoteDescription(new RTCSessionDescription(offer));
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForIce(peer);
    return encodeDescription(localDescription(peer));
  }

  async acceptAnswerCode(code: string) {
    const answer = decodeDescription(code);
    if (answer.type !== "answer") throw new Error("Expected a 101 WebRTC answer");
    await this.requirePeer().setRemoteDescription(new RTCSessionDescription(answer));
  }

  sendReliable(message: ControlMessage) {
    if (this.control?.readyState === "open") {
      this.control.send(this.codec.serializeControl(message));
    }
  }

  sendRealtime(message: RealtimeMessage) {
    if (this.realtime?.readyState !== "open" || this.realtime.bufferedAmount > 64 * 1024) return;
    const serialized = this.codec.serializeRealtime(message);
    if (typeof serialized === "string") this.realtime.send(serialized);
    else this.realtime.send(serialized as Uint8Array<ArrayBuffer>);
  }

  onMessage(callback: (message: LinkMessage) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onStateChange(callback: (state: LinkState) => void) {
    this.stateListeners.add(callback);
    callback(this.currentState);
    return () => this.stateListeners.delete(callback);
  }

  private attach(channel: NativeDataChannel) {
    if (channel.label === "101-control") {
      this.control = channel;
      channel.onmessage = (event: unknown) => {
        const data = (event as { data?: unknown }).data;
        if (typeof data !== "string") return;
        try {
          const payload = this.codec.deserializeControl(data);
          this.emit({ channel: "control", payload });
        } catch {
          // Ignore malformed remote control messages.
        }
      };
    }
    if (channel.label === "101-realtime") {
      this.realtime = channel;
      channel.binaryType = "arraybuffer";
      channel.onmessage = (event: unknown) => {
        const data = (event as { data?: unknown }).data;
        if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
        try {
          this.emit({ channel: "realtime", payload: this.codec.deserializeRealtime(data) });
        } catch {
          // Realtime packets are disposable.
        }
      };
    }
    channel.onopen = () => this.checkReady();
    channel.onclose = () => {
      if (this.currentState === "connected") this.setState("disconnected");
    };
  }

  private checkReady() {
    if (this.control?.readyState === "open" && this.realtime?.readyState === "open") {
      this.setState("connected");
    }
  }

  private emit(message: LinkMessage) {
    this.listeners.forEach((listener) => listener(message));
  }

  private setState(state: LinkState) {
    if (state === this.currentState) return;
    this.currentState = state;
    this.stateListeners.forEach((listener) => listener(state));
  }

  private requirePeer() {
    if (!this.peer) throw new Error("WebRTC transport is not connected");
    return this.peer;
  }
}

function localDescription(peer: RTCPeerConnection): { type: string; sdp: string } {
  const description = peer.localDescription;
  if (!description?.type || !description.sdp) throw new Error("WebRTC did not produce pairing data");
  return { type: description.type, sdp: description.sdp };
}

async function waitForIce(peer: RTCPeerConnection, timeoutMs = 5_000) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      peer.onicegatheringstatechange = null;
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    peer.onicegatheringstatechange = onChange;
  });
}
