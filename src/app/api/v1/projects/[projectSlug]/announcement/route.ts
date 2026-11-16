import { randomUUID } from 'node:crypto';
import { authenticateBearer } from '../../../../../../domain/credentials';
import { MAX_ANNOUNCEMENT_BODY_BYTES, MAX_ANNOUNCEMENT_TITLE_BYTES } from '../../../../../../domain/announcements/content';
import { setProjectAnnouncementByToken } from '../../../../../../domain/announcements';
import { DomainError } from '../../../../../../domain/kernel';
import { checkRateLimit } from '../../../../../../domain/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BYTES = MAX_ANNOUNCEMENT_BODY_BYTES + MAX_ANNOUNCEMENT_TITLE_BYTES + 1024;

/** Enforce the cap on observed bytes, including absent or dishonest Content-Length. */
async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_REQUEST_BYTES) throw new DomainError('content_too_large');
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) { void reader.cancel().catch(() => {}); throw new DomainError('content_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('validation_failed'); }
}

export async function PUT(request: Request, context: { params: Promise<{ projectSlug: string }> }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const principal = await authenticateBearer(request.headers.get('authorization'), { requestId: randomUUID(), interface: 'cli' });
    await checkRateLimit(principal, 'set_project_announcement');
    const input = await readBody(request);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('validation_failed');
    const { title, body } = input as { title: string; body: string };
    const { projectSlug } = await context.params;
    return Response.json(await setProjectAnnouncementByToken(principal, projectSlug, { title, body }), { headers });
  } catch (error) {
    if (!(error instanceof DomainError)) return Response.json({ error: { code: 'unavailable' } }, { status: 503, headers });
    const status = error.code === 'unauthenticated' ? 401
      : error.code === 'capability_denied' || error.code === 'org_suspended' ? 403
      : error.code === 'forbidden_or_not_found' ? 404
      : error.code === 'rate_limited' ? 429
      : error.code === 'validation_failed' || error.code === 'content_too_large' ? 400 : 503;
    return Response.json({ error: { code: error.code } }, { status, headers: {
      ...headers, ...(status === 429 ? { 'Retry-After': String(error.details.retryAfterSeconds) } : {}),
    } });
  }
}
