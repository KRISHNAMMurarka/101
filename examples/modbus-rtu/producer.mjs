// Disposable RTU byte-stream producer for the local software fixture. stdin
// and stdout stand in for an enrolled serial byte port; no device is opened.
let input = Buffer.alloc(0), value = 37;
function crc(bytes) {
  let result = 0xffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = result & 1 ? (result >>> 1) ^ 0xa001 : result >>> 1;
  }
  return result;
}
function frame(body) { const sum = crc(body); return Buffer.from([...body, sum & 255, sum >>> 8]); }
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 256) { process.exitCode = 2; process.stdin.destroy(); return; }
  while (input.length >= 8) {
    const request = input.subarray(0, 8); input = input.subarray(8);
    if (request[0] !== 1 || request[6] !== (crc(request.subarray(0, 6)) & 255) ||
      request[7] !== (crc(request.subarray(0, 6)) >>> 8)) { process.exitCode = 2; process.stdin.destroy(); return; }
    const address = request.readUInt16BE(2), word = request.readUInt16BE(4);
    let response;
    if (address !== 0) response = frame([1, request[1] | 0x80, 2]);
    else if (request[1] === 3 && word === 1) response = frame([1, 3, 2, value >>> 8, value & 255]);
    else if (request[1] === 6) { value = word; response = frame(request.subarray(0, 6)); }
    else response = frame([1, request[1] | 0x80, 1]);
    process.stdout.write(response);
  }
});
