import http from 'node:http';

// Disposable in-memory IPP/1.1 endpoint. It accepts bytes; it never prints.
const u16 = value => Buffer.from([value >>> 8, value & 255]);
const u32 = value => Buffer.from([value >>> 24, value >>> 16, value >>> 8, value]);
const attribute = (tag, name, value) => {
  const key = Buffer.from(name);
  const bytes = typeof value === 'number' ? u32(value) : typeof value === 'boolean' ? Buffer.from([value ? 1 : 0]) : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), u16(key.length), key, u16(bytes.length), bytes]);
};
function reply(status, id, group, values) {
  return Buffer.concat([Buffer.from([1, 1]), u16(status), u32(id), Buffer.from([1]),
    attribute(0x47, 'attributes-charset', 'utf-8'), attribute(0x48, 'attributes-natural-language', 'en'),
    ...(group ? [Buffer.from([group]), ...values.map(value => attribute(...value))] : []), Buffer.from([3])]);
}
function requestBody(bytes) {
  if (bytes.length < 9 || bytes[0] !== 1 || bytes[1] !== 1 || bytes[8] !== 1) throw new Error('bad header');
  const operation = bytes.readUInt16BE(2), id = bytes.readUInt32BE(4), attrs = new Map();
  let cursor = 9;
  while (cursor < bytes.length) {
    const tag = bytes[cursor++];
    if (tag === 3) return { operation, id, attrs, document: bytes.subarray(cursor) };
    if (tag === 2) continue;
    if (cursor + 2 > bytes.length) throw new Error('short name');
    const nameLength = bytes.readUInt16BE(cursor); cursor += 2;
    if (!nameLength || cursor + nameLength + 2 > bytes.length) throw new Error('bad name');
    const name = bytes.subarray(cursor, cursor + nameLength).toString(); cursor += nameLength;
    const length = bytes.readUInt16BE(cursor); cursor += 2;
    if (cursor + length > bytes.length || attrs.has(name)) throw new Error('bad value');
    attrs.set(name, { tag, value: bytes.subarray(cursor, cursor + length) }); cursor += length;
  }
  throw new Error('missing end');
}
let uri;
let nextJob = 1;
const jobs = new Map();
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/ipp/print' || req.headers['content-type'] !== 'application/ipp') {
    res.writeHead(400); res.end(); return;
  }
  const chunks = []; let length = 0;
  try {
    for await (const chunk of req) { length += chunk.length; if (length > 70_000) throw new Error('large request'); chunks.push(chunk); }
    const parsed = requestBody(Buffer.concat(chunks));
    process.stdout.write(`${JSON.stringify({ operation: parsed.operation })}\n`);
    if (parsed.attrs.get('attributes-charset')?.value.toString() !== 'utf-8' ||
      parsed.attrs.get('attributes-natural-language')?.value.toString() !== 'en' ||
      parsed.attrs.get('printer-uri')?.value.toString() !== uri) throw new Error('wrong printer');
    let group = 4, values = [];
    if (parsed.operation === 0x000b && parsed.document.length === 0) {
      values = [[0x22, 'printer-is-accepting-jobs', true], [0x49, 'document-format-supported', 'application/pdf']];
    } else if (parsed.operation === 0x0002 && parsed.attrs.get('document-format')?.value.toString() === 'application/pdf' &&
      parsed.attrs.get('copies')?.tag === 0x21 && parsed.attrs.get('copies')?.value.length === 4 &&
      parsed.attrs.get('copies')?.value.readInt32BE(0) === 1 &&
      parsed.document.length <= 65_536 && parsed.document.subarray(0, 5).toString() === '%PDF-') {
      group = 2; const job = nextJob++; jobs.set(job, 5);
      values = [[0x45, 'job-uri', uri.replace('/ipp/print', `/jobs/${job}`)],
        [0x21, 'job-id', job], [0x23, 'job-state', 5], [0x44, 'job-state-reasons', 'job-printing']];
    } else if ((parsed.operation === 0x0009 || parsed.operation === 0x0008) && parsed.document.length === 0) {
      const job = parsed.attrs.get('job-id');
      if (job?.tag !== 0x21 || job.value.length !== 4 || !jobs.has(job.value.readInt32BE(0))) throw new Error('unknown job');
      const id = job.value.readInt32BE(0);
      if (parsed.operation === 0x0008) { jobs.set(id, 7); group = 0; values = []; }
      else { group = 2; values = [[0x21, 'job-id', id], [0x23, 'job-state', jobs.get(id)],
        [0x44, 'job-state-reasons', jobs.get(id) === 7 ? 'job-canceled-by-user' : 'job-printing']]; }
    } else throw new Error('unsupported operation');
    const body = reply(0, parsed.id, group, values);
    res.writeHead(200, { 'content-type': 'application/ipp', 'content-length': body.length, connection: 'close' });
    res.end(body);
  } catch {
    res.writeHead(400, { connection: 'close' }); res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  uri = `ipp://127.0.0.1:${server.address().port}/ipp/print`;
  process.stdout.write(`${JSON.stringify({ uri })}\n`);
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
