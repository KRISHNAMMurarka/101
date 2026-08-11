# Controller pairing

## Phase 1 browser test

1. Launch 101 and open **Input Lab**.
2. Choose **Connect device**.
3. Open the provided controller link in another tab in the same browser profile.
4. The controller sends a capability hello; the host assigns Player 1.
5. D-pad and A-button events appear as normalized `move` and `trigger` frames.

This test intentionally uses `BroadcastChannel`. It proves the game/input/protocol boundary but does not cross devices.

## LAN WebRTC target

The Hub creates a session and advertises it locally. A native or PWA Link client discovers the Hub or scans a session code, confirms the host, exchanges capabilities, and opens control plus realtime DataChannels. The connection screen reports LAN, relay, or manual-offline mode rather than implying every path is strictly local.

## Entirely offline manual mode

The host exports a compressed WebRTC offer as QR or bounded text. The controller imports it, creates an answer, and transfers the answer back. No signaling server is required. This mode is less convenient but preserves full serverless pairing.
