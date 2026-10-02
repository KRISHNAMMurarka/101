/** Event callbacks consume only these documented fields; browser events may be richer. */
type EventCallback<T> = { handle(event: T): void }['handle'];
export interface PeerDataChannelPort {
  readonly label: string; readonly ordered: boolean; readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null; readonly readyState: string; readonly bufferedAmount: number;
  binaryType: string; bufferedAmountLowThreshold: number;
  onmessage: EventCallback<{ data: unknown }> | null;
  onclose: EventCallback<unknown> | null; onerror: EventCallback<unknown> | null;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(): void;
}
/** The exact RTC surface owned by the raw transport, independent of a complete DOM object. */
export interface PeerConnectionPort {
  readonly connectionState: string; readonly iceGatheringState: string;
  readonly localDescription: { type: RTCSdpType; sdp: string } | null;
  onconnectionstatechange: EventCallback<unknown> | null;
  ondatachannel: EventCallback<{ channel: PeerDataChannelPort }> | null;
  createDataChannel(label: string, options: RTCDataChannelInit): PeerDataChannelPort;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  removeEventListener(type: 'icegatheringstatechange', listener: () => void): void;
  getStats(): Promise<RTCStatsReport>;
  close(): void;
}
