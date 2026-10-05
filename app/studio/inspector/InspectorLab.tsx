'use client';

import { createRuntimeInspector } from '@101/device-runtime';
import type { Connection, EndpointHandle, InspectorSnapshot, RuntimeInspector } from '@101/device-runtime';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const QUEUE_CAPACITY = 4;
const EMPTY: InspectorSnapshot = { closed: false, resources: [], routes: [], trace: [], errors: [], traceCapacity: 24, maxTrackedRoutes: 8 };
const panel = { padding: 'var(--space-sm)', border: '1px solid var(--line)', minWidth: 0 };
const actions = { display: 'flex', flexWrap: 'wrap' as const, gap: 'var(--space-xs)', marginBlock: 'var(--space-sm)' };
const button = { minHeight: 44, whiteSpace: 'normal' as const };

function descriptor(sink = false, version = 1) {
  return { schemaVersion: 1, id: sink ? 'inspector-sink' : 'inspector-source', label: 'Local developer fixture', revision: 1,
    adapter: { id: 'example:inspector', version: '1.0.0' }, runtime: { platform: 'embedded-browser' },
    capabilities: [{ id: 'signal', semantic: 'example:inspector-switch', schemaVersion: version,
      kind: sink ? 'command' : 'event', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 5000 },
      permissions: [sink ? 'invoke' : 'subscribe'] }] };
}
interface Lab {
  inspector: RuntimeInspector; source: EndpointHandle; sink: EndpointHandle; route: Connection;
  allow: boolean; time: number; operation: number; delivered: number; released: number;
}

export default function InspectorLab() {
  const lab = useRef<Lab | null>(null);
  const [snapshot, setSnapshot] = useState<InspectorSnapshot>(EMPTY);
  const [counts, setCounts] = useState({ delivered: 0, released: 0 });
  const [status, setStatus] = useState('Starting local runtime.');

  const refresh = (message: string) => {
    const current = lab.current;
    if (!current) return;
    setSnapshot(current.inspector.snapshot());
    setCounts({ delivered: current.delivered, released: current.released });
    setStatus(message);
  };
  const setup = () => {
    lab.current?.inspector.close();
    const inspector = createRuntimeInspector({ now: () => current?.time ?? 0, traceCapacity: 24, maxTrackedRoutes: 8,
      authorize: () => current?.allow ? { expiresAt: current.time + 30000, maxAgeMs: 5000, maxHz: 100 } : undefined });
    const runtime = inspector.runtime;
    const source = runtime.registerSource({ device: descriptor(), capability: 'signal' });
    const sink = runtime.registerSink({ device: descriptor(true), capability: 'signal',
      apply(_observation, context) { if (context.isCurrent()) { current.delivered++; context.reportEvidence('observed'); } },
      release() { current.released++; } });
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    const route = runtime.route({ from: source, to: sink, principalId: 'developer', applicationId: 'sdk-inspector', sessionId: 'local',
      queueCapacity: QUEUE_CAPACITY });
    const current: Lab = { inspector, source, sink, route, allow: false, time: 0, operation: 0, delivered: 0, released: 0 };
    lab.current = current;
    refresh('Local runtime ready. Choose Allow grant or Deny grant to request a route.');
  };
  useEffect(() => {
    // The fixture uses an explicit clock so queue/expiry probes are reproducible.
    const timer = window.setTimeout(setup, 0);
    return () => { window.clearTimeout(timer); lab.current?.inspector.close(); lab.current = null; };
    // setup has no reactive inputs; all owned mutable state is in lab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestGrant = (allow: boolean) => {
    const current = lab.current; if (!current) return;
    current.route.stop(); current.allow = allow;
    current.route = current.inspector.runtime.route({ from: current.source, to: current.sink,
      principalId: 'developer', applicationId: 'sdk-inspector', sessionId: 'local', queueCapacity: QUEUE_CAPACITY });
    const result = current.route.start();
    refresh(result.ok ? 'Grant allowed. The typed route is active.' : allow ? 'Route unavailable. Restore source readiness and allow again.' : 'Grant denied. Delivery is blocked.');
  };
  const publish = (amount: number) => {
    const current = lab.current; if (!current) return;
    let accepted = 0;
    for (let index = 0; index < amount; index++) {
      const result = current.inspector.runtime.publish(current.source, true, {
        operationId: String(++current.operation), deadline: current.time + 5000 });
      if (result.ok && result.value.accepted > 0) accepted++;
    }
    refresh(`${accepted} accepted; ${amount - accepted} rejected. Values are excluded from diagnostics.`);
  };
  const flush = () => {
    const current = lab.current; if (!current) return;
    for (let index = 0; index < QUEUE_CAPACITY; index++) { current.time += 10; current.inspector.runtime.flush(); }
    refresh('Queue flushed through the local typed sink. Observed evidence refers to this fixture.');
  };
  const readiness = (available: boolean) => {
    const current = lab.current; if (!current) return;
    current.inspector.runtime.setReadiness(current.source, available ? 'available' : 'unavailable');
    refresh(available ? 'Source restored. Allow grant to create a fresh route.' : 'Source lost. Active delivery stopped and pending work was cancelled.');
  };
  const probe = (version: boolean) => {
    const current = lab.current; if (!current) return;
    try { current.inspector.runtime.registerSource({ device: version ? { ...descriptor(), schemaVersion: 2 }
      : { ...descriptor(), capabilities: 'invalid' }, capability: 'signal' }); }
    catch { /* The inspector retains a fixed diagnostic code, never the thrown message. */ }
    refresh(version ? 'Unsupported descriptor version rejected.' : 'Invalid descriptor schema rejected.');
  };
  const active = snapshot.routes.at(-1);
  const ready = snapshot.resources.length > 0 && !snapshot.closed;

  return <main className="controller-lab-page" data-testid="sdk-inspector">
    <header className="controller-lab-topbar" style={{ flexWrap: 'wrap', gap: 'var(--space-xs)', paddingBlock: 'var(--space-xs)' }}>
      <Link className="wordmark" href="/studio"><span className="mark-block">101</span><span className="mark-label">SDK INSPECTOR</span></Link>
      <b>LOCAL DEVELOPER RUNTIME</b>
    </header>
    <section className="controller-lab-intro">
      <p className="eyebrow">Independent SDK diagnostics</p>
      <h1>Inspect the route.</h1>
      <p>Request a host grant, enqueue a typed boolean event, and observe delivery to a local command sink. This runtime is independent of the game input bus. Reports include local aliases and fixed codes; sample values, device labels and identity fields are excluded.</p>
    </section>
    <p role="status" aria-live="polite" data-testid="inspector-status">{status}</p>
    <section aria-labelledby="grant-title" style={panel}>
      <h2 id="grant-title">Host grant</h2>
      <p>The developer actions below control the local host authorization callback. Each route request still passes SDK readiness, schema and ownership checks.</p>
      <div style={actions}>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => requestGrant(true)}>Allow grant</button>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => requestGrant(false)}>Deny grant</button>
        <button className="outline-button" style={button} disabled={!ready || active?.state !== 'active'} onClick={() => {
          const current = lab.current; if (current) current.inspector.runtime.revoke(current.route); refresh('Grant revoked. Pending delivery cancelled.');
        }}>Revoke grant</button>
        <button className="outline-button" style={button} onClick={setup}>Reset runtime</button>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => { lab.current?.inspector.close(); refresh('Runtime closed. Reset runtime to recover.'); }}>Close runtime</button>
      </div>
      <p data-testid="current-route">Current route: {active?.state ?? (snapshot.closed ? 'closed' : 'loading')} · grant: {active?.grant ?? 'not-requested'}{active?.reason ? ` · ${active.reason}` : ''}</p>
    </section>
    <section aria-labelledby="graph-title" style={{ ...panel, marginBlock: 'var(--space-sm)' }}>
      <h2 id="graph-title">Current resource graph</h2>
      {snapshot.resources.length === 0 ? <p>{snapshot.closed ? 'The owned runtime and resource handles have been released.' : 'Loading resources.'}</p> : <ul data-testid="resource-graph">{snapshot.resources.map(resource =>
        <li key={resource.id}><strong>{resource.id}</strong> · {resource.role} · {resource.readiness} · {resource.kind} / {resource.valueType} v{resource.schemaVersion} · {resource.delivery} · {resource.permissions.join(', ')}</li>)}</ul>}
      <ol data-testid="route-graph">{snapshot.routes.map(route => <li key={route.id}>{route.id}: {route.source} → {route.sink} · {route.sourceOperation} → {route.sinkOperation} · {route.state} · {route.grant}</li>)}</ol>
      {snapshot.resources.some(resource => resource.readiness === 'unknown') && <p>The public runtime could not confirm readiness after a stale admission. Set resource readiness explicitly to recover a known state.</p>}
      <div style={actions}>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => readiness(false)}>Lose source readiness</button>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => readiness(true)}>Restore source readiness</button>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => {
          const current = lab.current; if (current) { current.time += 30001; current.inspector.runtime.flush(); } refresh('Route lease and host grant expired. Allow again to recover.');
        }}>Expire grant</button>
      </div>
    </section>
    <section aria-labelledby="queue-title" style={panel}>
      <h2 id="queue-title">Bounded queue and sink evidence</h2>
      <p data-testid="queue-status">Pending: {active?.pending ?? 0} / {active?.queueCapacity ?? QUEUE_CAPACITY} · observed deliveries: {counts.delivered} · releases: {counts.released}</p>
      <p>Limits: {active?.limits ? `${active.limits.maxHz} Hz · ${active.limits.maxAgeMs} ms maximum age · expiry ${active.limits.expiresAt} ms in the fixture clock` : 'No active negotiated grant.'}</p>
      <div style={actions}>
        <button className="outline-button" style={button} disabled={!ready || active?.state !== 'active'} onClick={() => publish(1)}>Enqueue event</button>
        <button className="outline-button" style={button} disabled={!ready || active?.state !== 'active'} onClick={() => publish(6)}>Probe queue bound</button>
        <button className="outline-button" style={button} disabled={!ready || active?.state !== 'active'} onClick={flush}>Flush queue</button>
      </div>
      <ul data-testid="operation-records">{active?.operations.map(operation => <li key={operation.id}>{operation.id} · {operation.state} · handler {operation.handlerResult} · effect {operation.effectEvidence}</li>)}</ul>
      <p>The sink records an observed local application effect. It supplies no physical actuator or phone qualification evidence.</p>
    </section>
    <section aria-labelledby="errors-title" style={{ ...panel, marginBlock: 'var(--space-sm)' }}>
      <h2 id="errors-title">Schema and version errors</h2>
      <div style={actions}>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => probe(false)}>Probe invalid schema</button>
        <button className="outline-button" style={button} disabled={!ready} onClick={() => probe(true)}>Probe unsupported version</button>
      </div>
      {snapshot.errors.length === 0 ? <p>No retained errors.</p> : <ul data-testid="inspector-errors">{snapshot.errors.map(entry => <li key={entry.sequence}>{entry.action} · {entry.code}</li>)}</ul>}
    </section>
    <section aria-labelledby="trace-title" style={panel}>
      <h2 id="trace-title">Redacted trace</h2>
      <p data-testid="trace-bound">Retained: {snapshot.trace.length} / {snapshot.traceCapacity} entries · at most {snapshot.maxTrackedRoutes} routes</p>
      <ol data-testid="inspector-trace">{snapshot.trace.map(entry => <li key={entry.sequence}>{entry.sequence} · {entry.action} · {entry.target} · {entry.result}{entry.code ? ` · ${entry.code}` : ''}</li>)}</ol>
    </section>
  </main>;
}
