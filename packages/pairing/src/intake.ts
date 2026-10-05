import type { PairingTicket } from '@101/protocol';

export interface PairingCandidate {
  readonly input: string;
  readonly ticket: Readonly<PairingTicket>;
  readonly source: 'link' | 'scan' | 'saved' | 'paste';
}

export type PairingIntakeResult =
  | { readonly status: 'review'; readonly candidate: PairingCandidate }
  | { readonly status: 'invalid' | 'expired' | 'rate-limited' | 'unchanged' | 'invalid-clock' | 'cancelled' };

/** Bounded inert intake. Approval consumes a reviewed value; the caller owns every connection. */
export function createPairingIntake(options: {
  parse(input: string, now: number): Readonly<PairingTicket>;
  now?: () => number;
}) {
  const clock = options.now ?? Date.now;
  const parse = options.parse;
  let current: PairingCandidate | undefined;
  let revision = 0;
  let lastTime = 0;
  let windowStarted = -1;
  let windowCount = 0;
  let lastScan: string | undefined;
  const invalidate = () => { current = undefined; revision++; };
  const clear = () => { invalidate(); lastScan = undefined; };
  const readTime = () => {
    let value: number;
    try { value = clock(); } catch { invalidate(); return undefined; }
    if (!Number.isSafeInteger(value) || value < lastTime || value < 0) { invalidate(); return undefined; }
    lastTime = value;
    return value;
  };
  return {
    get revision() { return revision; },
    receive(input: string, source: PairingCandidate['source']): PairingIntakeResult {
      const now = readTime();
      if (now === undefined) return { status: 'invalid-clock' };
      if (typeof input !== 'string' || input.length > 8192 || !['link', 'scan', 'saved', 'paste'].includes(source)) { invalidate(); return { status: 'invalid' }; }
      if (source === 'scan' && lastScan === input) return { status: 'unchanged' };
      if (windowStarted < 0 || now - windowStarted >= 1000) { windowStarted = now; windowCount = 0; }
      if (windowCount >= 8) return { status: 'rate-limited' };
      windowCount++;
      if (source === 'scan') lastScan = input;
      invalidate();
      const expected = revision;
      try {
        const parsed = snapshotTicket(parse(input, now));
        if (expected !== revision) return { status: 'cancelled' };
        if (!Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= now || parsed.expiresAt - now > 86_400_000)
          return { status: parsed.expiresAt <= now ? 'expired' : 'invalid' };
        const candidate = Object.freeze({ input, source, ticket: parsed });
        if (expected !== revision) return { status: 'cancelled' };
        current = candidate;
        return { status: 'review', candidate };
      } catch (error) {
        return { status: error instanceof Error && /expired/i.test(error.message) ? 'expired' : 'invalid' };
      }
    },
    approve(candidate: PairingCandidate): boolean {
      const now = readTime();
      if (now === undefined) return false;
      if (candidate !== current) return false;
      if (candidate.ticket.expiresAt <= now) { invalidate(); return false; }
      invalidate();
      return true;
    },
    clear,
  };
}

function snapshotTicket(value: Readonly<PairingTicket>): Readonly<PairingTicket> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Invalid parsed ticket');
  const allowed = ['version', 'sessionId', 'endpoint', 'joinToken', 'expiresAt', 'hostName', 'transport'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(descriptors).some(descriptor => !('value' in descriptor))) throw Error('Invalid parsed ticket');
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))) as unknown as Readonly<PairingTicket>;
}
