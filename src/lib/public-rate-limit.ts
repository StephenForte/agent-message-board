/**
 * In-memory limits for anonymous public pages (D-036).
 * Fixed windows aligned to the clock. No Next.js and no database imports:
 * one process holds one instance, and staging runs one instance.
 */

export const PUBLIC_RATE_LIMIT_PER_ADDRESS = 60;
export const PUBLIC_RATE_LIMIT_GLOBAL = 600;
export const PUBLIC_RATE_LIMIT_MAX_ADDRESSES = 10_000;
export const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;

const ADDRESS_KEY_MAX = 64;

export type PublicRateLimitDecision =
  | { allowed: true }
  | { allowed: false; scope: 'address' | 'global'; retryAfterSeconds: number };

type LimiterOptions = {
  perAddress: number;
  global: number;
  maxAddresses: number;
  windowMs: number;
  now: () => number;
};

type AddressCount = { windowId: number; count: number };

/** True-Client-IP, else the first X-Forwarded-For hop, else the single key `unknown`. */
export function publicClientAddress(headers: { get(name: string): string | null }): string {
  return normalizeAddress(headers.get('true-client-ip'), false)
    ?? normalizeAddress(headers.get('x-forwarded-for'), true)
    ?? 'unknown';
}

function normalizeAddress(value: string | null, firstHop: boolean): string | null {
  if (value == null) return null;
  const hop = firstHop ? (value.split(',')[0] ?? '') : value;
  const trimmed = hop.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, ADDRESS_KEY_MAX);
}

export function createPublicRateLimiter(options: LimiterOptions): (address: string) => PublicRateLimitDecision {
  const addresses = new Map<string, AddressCount>();
  let globalWindow = Number.NaN;
  let globalCount = 0;

  const retryAfterSeconds = (now: number) => {
    const start = Math.floor(now / options.windowMs) * options.windowMs;
    const seconds = Math.ceil((start + options.windowMs - now) / 1000);
    if (seconds < 1) return 1;
    if (seconds > 60) return 60;
    return seconds;
  };

  return (address) => {
    const now = options.now();
    const windowId = Math.floor(now / options.windowMs);
    if (windowId !== globalWindow) {
      globalWindow = windowId;
      globalCount = 0;
    }

    const current = addresses.get(address);
    const addressCount = current !== undefined && current.windowId === windowId ? current.count : 0;
    // Per-address first, so retries after a client's own 429 do not spend the shared budget.
    // A global rejection returns before the address count moves, so it does not spend that budget either.
    if (addressCount >= options.perAddress) {
      return { allowed: false, scope: 'address', retryAfterSeconds: retryAfterSeconds(now) };
    }
    if (globalCount >= options.global) {
      return { allowed: false, scope: 'global', retryAfterSeconds: retryAfterSeconds(now) };
    }

    globalCount += 1;
    if (current !== undefined && current.windowId === windowId) {
      current.count += 1;
    } else if (current !== undefined) {
      current.windowId = windowId;
      current.count = 1;
    } else if (reserveAddress(addresses, windowId, options.maxAddresses)) {
      addresses.set(address, { windowId, count: 1 });
    }
    return { allowed: true };
  };
}

function reserveAddress(addresses: Map<string, AddressCount>, windowId: number, maxAddresses: number): boolean {
  if (addresses.size < maxAddresses) return true;
  for (const [key, state] of addresses) {
    if (state.windowId < windowId) addresses.delete(key);
  }
  return addresses.size < maxAddresses;
}
