type Callback<T> = { handle(event: T): void }['handle'];
/** Native browser WebSocket surface; accepted TLS hosts adapt their owned socket here. */
export interface WebSocketPort {
  readonly readyState: number; readonly protocol: string; readonly bufferedAmount: number;
  binaryType: string;
  onopen: Callback<unknown> | null; onclose: Callback<unknown> | null; onerror: Callback<unknown> | null;
  onmessage: Callback<{ data: unknown }> | null;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(): void;
}
