/** Keep network and decoder internals off the player-facing connection screen. */
export function connectionErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  if (/expired/i.test(message)) return "This code expired. Open a new one on the game screen.";
  if (/room code only names the game/i.test(message)) {
    return "This room code only names the game. Scan or paste the full connection link.";
  }
  if (/pairing code|pairing ticket|pairing session|pairing authorization|pairing endpoint/i.test(message)) {
    return "That code could not be used. Scan a new code on the game screen.";
  }
  return "Could not connect. Keep both devices on the same Wi-Fi and try again.";
}
