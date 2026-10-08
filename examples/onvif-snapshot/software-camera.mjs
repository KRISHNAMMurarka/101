import { createServer } from 'node:http';

const frames = [
  Buffer.from('/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCe4CqYO//Z', 'base64'),
  Buffer.from('/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAYqm//Z', 'base64'),
];
let sequence = 0;
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const address = server.address();
  if (request.method === 'POST' && request.url === '/onvif/media_service') {
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body.includes('<trt:ProfileToken>profile-a</trt:ProfileToken>')) { response.writeHead(400, { connection: 'close' }); response.end(); return; }
    const uri = `http://127.0.0.1:${address.port}/snapshot/profile-a.jpg`;
    const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body><trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${uri}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetSnapshotUriResponse></s:Body></s:Envelope>`;
    response.writeHead(200, { 'content-type': 'application/soap+xml', 'content-length': Buffer.byteLength(soap), connection: 'close' }); response.end(soap);
    process.stdout.write(`${JSON.stringify({ operation: 'GetSnapshotUri' })}\n`); return;
  }
  if (request.method === 'GET' && request.url === '/snapshot/profile-a.jpg') {
    const frame = frames[sequence++ % frames.length]; response.writeHead(200,
      { 'content-type': 'image/jpeg', 'content-length': frame.length, connection: 'close' }); response.end(frame);
    process.stdout.write(`${JSON.stringify({ operation: 'GetSnapshot', sequence })}\n`); return;
  }
  response.writeHead(404, { connection: 'close' }); response.end();
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ port: server.address().port,
  servicePath: '/onvif/media_service', snapshotPath: '/snapshot/profile-a.jpg', profileToken: 'profile-a' })}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
