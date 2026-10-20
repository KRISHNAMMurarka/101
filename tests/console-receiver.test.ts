import assert from 'node:assert/strict';
import test from 'node:test';

import * as receiver from '../apps/console-receiver/src/receiver.ts';

test('console receiver admits one exact bundled HTTPS origin and loopback development only', () => {
  assert.equal(typeof receiver.allowedReceiverLocation, 'function', 'the receiver origin guard must exist');
  for (const url of ['https://101-receiver.invalid/index.html', 'http://127.0.0.1:4177/', 'http://localhost:4177/index.html'])
    assert.equal(receiver.allowedReceiverLocation(url), true, url);
  for (const url of ['https://101-receiver.invalid.evil.test/', 'https://101-receiver.invalid:444/', 'https://101-receiver.invalid/elsewhere',
    'http://101-receiver.invalid/', 'https://user@101-receiver.invalid/index.html', 'https://example.com/', 'file:///receiver/index.html', 'garbage'])
    assert.equal(receiver.allowedReceiverLocation(url), false, url);
});

test('console receiver stays inert without native secure RTC and crypto capabilities', () => {
  assert.equal(typeof receiver.receiverAvailability, 'function', 'the receiver capability probe must exist');
  const ready = { href: 'https://101-receiver.invalid/index.html', secure: true, rtc: true, crypto: true };
  assert.equal(receiver.receiverAvailability(ready), 'ready');
  assert.equal(receiver.receiverAvailability({ ...ready, secure: false }), 'unavailable');
  assert.equal(receiver.receiverAvailability({ ...ready, rtc: false }), 'unavailable');
  assert.equal(receiver.receiverAvailability({ ...ready, crypto: false }), 'unavailable');
  assert.equal(receiver.receiverAvailability({ ...ready, href: 'https://example.com/' }), 'unavailable');
});
