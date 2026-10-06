import type { RouteGrant } from './types.ts';

/** Selected local-media constraints only. Possession of this data grants no resource access. */
export function intersectMediaRouteGrants(source: unknown, sink: unknown, at: number): RouteGrant | undefined {
  if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER) return;
  function read(input: unknown): RouteGrant | undefined {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 3 || keys.some(key => !['expiresAt', 'maxHz', 'maxAgeMs'].includes(String(key)))) return;
    const fields = ['expiresAt', 'maxHz', 'maxAgeMs'].map(key => Object.getOwnPropertyDescriptor(input, key));
    if (fields.some(field => !field || !field.enumerable || !Object.hasOwn(field, 'value'))) return;
    const [expiresAt, maxHz, maxAgeMs] = fields.map(field => field!.value as unknown);
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= at || expiresAt > at + 30000 ||
        typeof maxHz !== 'number' || !Number.isFinite(maxHz) || maxHz < 1 || maxHz > 30 ||
        typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 1000) return;
    return { expiresAt, maxHz, maxAgeMs };
  }
  try {
    const a = read(source), b = read(sink); if (!a || !b) return;
    return Object.freeze({ expiresAt: Math.min(a.expiresAt, b.expiresAt), maxHz: Math.min(a.maxHz!, b.maxHz!), maxAgeMs: Math.min(a.maxAgeMs, b.maxAgeMs) });
  } catch { return; }
}
