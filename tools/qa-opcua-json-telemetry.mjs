import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startOwnedMqttBroker } from './qa-mqtt-connector.mjs';
import { runOpcUaJsonTelemetryConsumer } from '../examples/opcua-json-telemetry/consumer.mjs';

const owned = ['packages/hub-server/src/opcua-json-telemetry.ts','packages/hub-server/src/opcua-json-telemetry.test.ts',
  'examples/opcua-json-telemetry/producer.mjs','examples/opcua-json-telemetry/consumer.mjs',
  'tools/qa-opcua-json-telemetry.mjs','tools/qa-installed-opcua-json-telemetry.mjs'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function files(directory) { return readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))
  .flatMap(entry => entry.isDirectory() ? files(join(directory,entry.name)) : entry.isFile() ? [join(directory,entry.name)] : []); }
/** The helper imports the older MQTT caller even when only broker startup is used.
 * Fingerprint that executed module closure and the seven public source packages. */
export function opcUaQaSourceFingerprints() {
  const root = resolve(import.meta.dirname,'..'), helperRoot = resolve(dirname(realpathSync(join(root,'tools/qa-mqtt-connector.mjs'))),'..');
  const selected = owned.map(path=>join(root,path));
  for (const name of ['connect','device-model','device-runtime','device-web','transport-webrtc','transport-websocket','vision'])
    selected.push(...files(join(helperRoot,'packages',name,'src')));
  selected.push(join(helperRoot,'tools/qa-mqtt-connector.mjs'), join(helperRoot,'tools/mqtt-broker-binary.mjs'), join(helperRoot,'packages/hub-server/src/mqtt-connector.ts'));
  for (const name of ['caller','producer','decoder','profile']) selected.push(join(helperRoot,'examples/mqtt-connector',name+'.mjs'));
  const mqttRoot = dirname(realpathSync(join(root,'node_modules/mqtt/package.json')));
  // Existing installed graph includes transitive metadata; broker/producer/provider
  // use the same installed MQTT graph in this source check.
  const pkgDirectories = new Set();
  function dependencies(directory) {
    if (pkgDirectories.has(directory)) return; pkgDirectories.add(directory);
    const metadata = JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      let at = directory, target;
      for (;;) { const candidate = join(at,'node_modules',dependency,'package.json');
        try { if(statSync(candidate).isFile()){target=dirname(realpathSync(candidate));break;} } catch { /* Search normal package ancestors. */ }
        const parent=dirname(at); assert.notEqual(parent,at,`installed dependency missing ${dependency}`);at=parent;
      }
      dependencies(target);
    }
  }
  dependencies(mqttRoot);
  for (const directory of pkgDirectories) selected.push(...files(directory).filter(path=>!path.slice(directory.length+1).startsWith('node_modules/')));
  return Object.fromEntries([...new Set(selected)].sort().map(path=>[path,sha256(readFileSync(path))]));
}
export async function runOpcUaJsonTelemetryQa() {
  const before=opcUaQaSourceFingerprints(),broker=await startOwnedMqttBroker();let result;
  try {result=await runOpcUaJsonTelemetryConsumer(broker.endpoint);}finally{await broker.close();}
  assert.deepEqual(opcUaQaSourceFingerprints(),before,'executed source/helper/dependency bytes changed');
  return Object.freeze({ schemaVersion:1,status:'pass',sourceSha256:before,broker:{version:broker.version,ownedPid:broker.pid,listener:'127.0.0.1 only',settled:true},result,
    scope:'Actual standard OPC UA JSON/MQTT software producer; public source SDK caller. Installed SDK proof, physical gateway, CAN/CANopen and certification remain open.' });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  try {console.log(JSON.stringify(await runOpcUaJsonTelemetryQa()));}catch(error){console.error(error);process.exitCode=1;}
}
