import assert from 'node:assert/strict';
import test from 'node:test';
import { createModbusRtuConnector, type ModbusRtuSerialPort } from './modbus-rtu.ts';

class BytePort implements ModbusRtuSerialPort {
  readonly identity = 'fixture:rtu-port-1';
  readonly written: string[] = [];
  closed = false;
  closeCalls = 0;
  onClose?: () => void;
  onWrite?: () => void;
  watermarkHold?: Promise<void>;
  private queued: { byte: number; at: number }[] = [];
  private wake?: () => void;
  private ending = false;
  private readonly answer: (hex: string) => string | undefined;
  private readonly writeSettlement?: Promise<void>;
  constructor(answer: (hex: string) => string | undefined, writeSettlement?: Promise<void>) {
    this.answer = answer; this.writeSettlement = writeSettlement;
  }
  readonly bytes = this.readBytes();
  inject(hex: string, at = performance.now()): void {
    for (const byte of Buffer.from(hex, 'hex')) this.queued.push({ byte, at });
    this.wake?.(); this.wake = undefined;
  }
  private async *readBytes(): AsyncIterable<{ byte: number; at: number }> {
    while (!this.ending) {
      if (!this.queued.length) await new Promise<void>(resolve => { this.wake = resolve; });
      while (this.queued.length) yield this.queued.shift()!;
    }
  }
  async write(bytes: Uint8Array): Promise<void> {
    const hex = Buffer.from(bytes).toString('hex'); this.written.push(hex);
    const reply = this.answer(hex);
    if (reply) this.inject(reply);
    this.onWrite?.();
    await this.writeSettlement;
  }
  async watermark(throughAt: number): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, throughAt - performance.now())));
    await this.watermarkHold;
    return throughAt;
  }
  async close(): Promise<void> { this.closeCalls++; this.onClose?.(); this.closed = true; this.ending = true; this.wake?.(); }
}

function fixture(answer: (hex: string) => string | undefined, writeSettlement?: Promise<void>) {
  const owner = new AbortController(), grant = new AbortController();
  const port = new BytePort(answer, writeSettlement); let allowed = true, opens = 0;
  const connector = createModbusRtuConnector({
    ownerSignal: owner.signal, scope: { principalId: 'operator', applicationId: 'rtu-gateway', sessionId: 'owned-fixture' },
    port: { id: port.identity, baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8 },
    profile: { id: 'selected:holding-register', revision: 1, unitId: 1, registers: [
      { id: 'reading', address: 0, access: 'read', unit: '1', scale: 0.5, offset: 1 },
      { id: 'setting', address: 0, access: 'write', unit: '1', scale: 0.5, offset: 1 },
    ] },
    authorize(request) { return allowed ? { request, signal: grant.signal, expiresAt: performance.now() + 10_000 } : undefined; },
    async openPort() { opens++; return port; },
  });
  return { connector, port, owner, grant, opens: () => opens, allow(value: boolean) { allowed = value; } };
}
const operation = () => ({ purpose: 'selected-register', signal: new AbortController().signal, deadline: performance.now() + 1000 });

test('exact FC03/FC06 RTU frames yield a scaled reading and separate target acknowledgement', async () => {
  const f = fixture(hex => hex === '010300000001840a' ? '0103020025799f' : hex === '01060000002a0815' ? hex : undefined);
  try {
    f.allow(false);
    assert.equal((await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 })).ok, false);
    assert.equal(f.opens(), 0);
    f.allow(true);
    const start = await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 }); assert.ok(start.ok);
    const read = await f.connector.read(start.value, 'reading', operation()); assert.ok(read.ok);
    assert.equal(read.value.rawValue, 37); assert.equal(read.value.value, 19.5);
    const write = await f.connector.write(start.value, 'setting', 22, operation()); assert.ok(write.ok);
    assert.equal(write.value.evidence, 'target-acknowledged');
    assert.deepEqual(f.port.written, ['010300000001840a', '01060000002a0815']);
    await f.connector.stop(); assert.equal(f.port.closed, true);
    assert.equal((await f.connector.read(start.value, 'reading', operation())).ok, false);
  } finally { await f.connector.close(); }
});

test('a valid exception frame is a failure; bad CRC retires the port', async () => {
  for (const response of ['018602c3a1', '01030200257900']) {
    const f = fixture(() => response);
    try {
      const started = await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 }); assert.ok(started.ok);
      const result = await f.connector.write(started.value, 'setting', 22, operation());
      assert.deepEqual(result, response.slice(2, 4) === '86' ? { ok: false, reason: 'exception', issued: true, uncertain: true } :
        { ok: false, reason: 'protocol', issued: true, uncertain: true });
      await f.connector.stop(); assert.equal(f.port.closed, true);
    } finally { await f.connector.close(); }
  }
});

test('a valid CRC prefix followed by another byte cannot acknowledge an FC06 command', async () => {
  const f = fixture(() => '01060000002a081500');
  try {
    const started = await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    assert.deepEqual(await f.connector.write(started.value, 'setting', 22, operation()),
      { ok: false, reason: 'protocol', issued: true, uncertain: true });
  } finally { await f.connector.close(); }
});

test('a physically early trailing byte delivered after the JS silence timer still invalidates the reply', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => '01060000002a0815');
  f.port.watermarkHold = held;
  f.port.onWrite = () => {
    const physicalAt = performance.now() + 1;
    setTimeout(() => { f.port.inject('00', physicalAt); setImmediate(release); }, 15);
  };
  try {
    const started = await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    assert.deepEqual(await f.connector.write(started.value, 'setting', 22, operation()),
      { ok: false, reason: 'protocol', issued: true, uncertain: true });
  } finally { release(); await f.connector.close(); }
});

test('revoking an issued write keeps its raw slot until the exact port closes', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => undefined, held);
  try {
    const started = await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    const writing = f.connector.write(started.value, 'setting', 22, operation());
    for (let turn = 0; turn < 20 && !f.port.written.length; turn++) await Promise.resolve();
    assert.equal(f.port.written.length, 1);
    assert.equal(f.connector.status().rawPending, 1);
    f.grant.abort();
    assert.deepEqual(await writing, { ok: false, reason: 'cancelled', issued: true, uncertain: true });
    let stopped = false;
    const stopping = f.connector.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.port.closed, true);
    assert.equal(stopped, false, 'Stop must join the real held write callback');
    assert.equal(f.connector.status().rawPending, 1);
    release(); await stopping;
    assert.equal(f.connector.status().rawPending, 0);
  } finally { release(); await f.connector.close(); }
});

test('a native close callback that calls Stop joins one teardown', async () => {
  const f = fixture(() => undefined);
  try {
    const started = await f.connector.start({ purpose: 'approved-port', deadline: performance.now() + 1000 }); assert.ok(started.ok);
    f.port.onClose = () => { void f.connector.stop(); };
    await f.connector.stop();
    assert.equal(f.port.closeCalls, 1);
    assert.equal(f.connector.status().nativePorts, 0);
  } finally { await f.connector.close(); }
});
