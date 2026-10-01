/** Ownership is scoped to a concrete sink registration (and optional partition). */
export class LeaseBook {
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();

  claim(key: string, owner: string, expiresAt: number, now: number): boolean {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
    const previous = this.leases.get(key);
    if (previous && previous.expiresAt > now && previous.owner !== owner) return false;
    this.leases.set(key, { owner, expiresAt });
    return true;
  }

  renew(key: string, owner: string, expiresAt: number, now: number): boolean {
    const previous = this.leases.get(key);
    if (!previous || previous.owner !== owner || previous.expiresAt <= now) return false;
    return this.claim(key, owner, expiresAt, now);
  }

  release(key: string, owner: string): boolean {
    if (this.leases.get(key)?.owner !== owner) return false;
    return this.leases.delete(key);
  }

  clear(): void { this.leases.clear(); }
}
