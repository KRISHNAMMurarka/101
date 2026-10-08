import type { ControlMessage } from "@101/protocol";

/** Desktop control's four-timestamp exchange and input frames must use the
 * same monotonic source clock. Ordinary game sessions keep wall time. */
export function sessionInputNow(gameId: string | undefined, wallNow: () => number,
  monotonicNow: () => number): number {
  return gameId === "desktop-control" ? monotonicNow() : wallNow();
}

/** The ordered reliable channel carries t2 in pong, then t3 in a scoped
 * deviceId-less ping. The dedicated one-peer host combines these with t1/t4.
 * Ordinary game sessions retain their existing single pong behavior.
 */
export function answerClockProbe(message: Extract<ControlMessage, { type: "ping" }>,
  gameId: string | undefined, deviceId: string, now: () => number,
  send: (message: ControlMessage) => void): void {
  const remoteReceivedAt = now();
  send({ type: "pong", sentAt: message.sentAt, receivedAt: remoteReceivedAt });
  if (gameId === "desktop-control" && message.deviceId === deviceId) {
    const remoteSentAt = now();
    send({ type: "ping", sentAt: remoteSentAt });
  }
}
