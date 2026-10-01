import assert from "node:assert/strict";
import test from "node:test";

import { connectionErrorMessage } from "./link-error.ts";

test("connection failures do not expose raw platform errors", () => {
  const message = connectionErrorMessage(new Error("fetch failed: java.net.ConnectException: /192.168.0.5:10101"));
  assert.equal(message, "Could not connect. Keep both devices on the same Wi-Fi and try again.");
});

test("expired QR codes receive a direct recovery message", () => {
  assert.equal(connectionErrorMessage(new Error("Pairing ticket has expired")), "This code expired. Open a new one on the game screen.");
});
