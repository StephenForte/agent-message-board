import { NextResponse, type NextRequest } from 'next/server';
import { publicRobotsTag } from './domain/organizations/reserved-slugs';
import { createLogger, requestId } from './lib/log';
import {
  PUBLIC_RATE_LIMIT_GLOBAL,
  PUBLIC_RATE_LIMIT_MAX_ADDRESSES,
  PUBLIC_RATE_LIMIT_PER_ADDRESS,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
  createPublicRateLimiter,
  publicClientAddress,
} from './lib/public-rate-limit';

const logLevels = ['debug', 'info', 'warn', 'error', 'silent'] as const;
type LogLevel = (typeof logLevels)[number];

function readLogLevel(value: string | undefined): LogLevel {
  for (const level of logLevels) if (level === value) return level;
  return 'info';
}

/** Public pages are exactly the paths `publicRobotsTag` marks, including unknown orgs and projects. */
export function isPublicRateLimitedPath(pathname: string): boolean {
  return publicRobotsTag(pathname) !== null;
}

// One instance for the life of the Node process. `npm start` keeps this module loaded.
const publicPageLimiter = createPublicRateLimiter({
  perAddress: PUBLIC_RATE_LIMIT_PER_ADDRESS,
  global: PUBLIC_RATE_LIMIT_GLOBAL,
  maxAddresses: PUBLIC_RATE_LIMIT_MAX_ADDRESSES,
  windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
  now: () => Date.now(),
});

const log = createLogger(readLogLevel(process.env.LOG_LEVEL));

type Scope = 'address' | 'global';
const rejections: Record<Scope, number> = { address: 0, global: 0 };
const previousRejections: Record<Scope, number> = { address: 0, global: 0 };
const loggedWindow: Record<Scope, number> = { address: -1, global: -1 };
let rejectionWindowId = -1;

function syncRejectionWindow(now: number): number {
  const windowId = Math.floor(now / PUBLIC_RATE_LIMIT_WINDOW_MS);
  if (windowId === rejectionWindowId) return windowId;
  if (windowId === rejectionWindowId + 1) {
    previousRejections.address = rejections.address;
    previousRejections.global = rejections.global;
  } else {
    previousRejections.address = 0;
    previousRejections.global = 0;
  }
  rejections.address = 0;
  rejections.global = 0;
  rejectionWindowId = windowId;
  return windowId;
}

function observePublicRequest(now: number, rejected: Scope | null) {
  const windowId = syncRejectionWindow(now);
  if (!rejected) return;
  rejections[rejected] += 1;
  if (loggedWindow[rejected] === windowId) return;
  loggedWindow[rejected] = windowId;
  log('warn', {
    operation: 'public_rate_limit',
    scope: rejected,
    rejected_previous_window: previousRejections[rejected],
  });
}

export function proxy(request: NextRequest) {
  const id = requestId(request.headers.get('x-request-id'));
  const pathname = request.nextUrl.pathname;
  if (isPublicRateLimitedPath(pathname)) {
    const now = Date.now();
    const decision = publicPageLimiter(publicClientAddress(request.headers));
    if (!decision.allowed) {
      observePublicRequest(now, decision.scope);
      return new NextResponse('Too many requests. Try again shortly.\n', {
        status: 429,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-request-id': id,
          'Retry-After': String(decision.retryAfterSeconds),
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex',
        },
      });
    }
    observePublicRequest(now, null);
  }
  const headers = new Headers(request.headers);
  headers.set('x-request-id', id);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-request-id', id);
  const tag = publicRobotsTag(pathname);
  if (tag) response.headers.set('X-Robots-Tag', tag);
  return response;
}
