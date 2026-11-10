import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateBearer } from '../domain/credentials';
import { DomainError } from '../domain/kernel';
import { requestId } from '../lib/log';
import { errorResult } from './results';
import { createMcpServer } from './tools';

export const MAX_BODY_BYTES = 65536;
function failure(error: unknown, status: number, id: string): Response {
  const result = errorResult(error);
  return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000,
    message: (result.structuredContent!.error as { message: string }).message, data: result.structuredContent!.error } },
  { status, headers: { 'x-request-id': id, 'Cache-Control': 'no-store' } });
}
/** Enforce the cap on observed bytes, including absent or dishonest Content-Length. */
async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) throw new DomainError('content_too_large');
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new DomainError('content_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('validation_failed'); }
}
export async function handleMcpRequest(request: Request): Promise<Response> {
  const id = requestId(request.headers.get('x-request-id'));
  let principal;
  const authorization = request.headers.get('authorization');
  try { principal = await authenticateBearer(authorization, { requestId: id, interface: 'mcp' }); }
  catch (error) {
    return failure(error, error instanceof DomainError && error.code === 'unauthenticated' ? 401
      : error instanceof DomainError && error.code === 'org_suspended' ? 403 : 503, id);
  }
  let parsedBody: unknown;
  if (request.method === 'POST') {
    try { parsedBody = await readBody(request); }
    catch (error) { return failure(error, error instanceof DomainError && error.code === 'content_too_large' ? 413 : 400, id); }
  }
  // Authenticate first, then retain only the verified public prefix, never the bearer secret.
  const prefix = /^Bearer amb_([A-Za-z0-9]{8})_/i.exec(authorization!)![1]!;
  const server = createMcpServer(principal, prefix);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    // JSON mode finishes the operation before handleRequest resolves; no live SSE state survives.
    response.headers.set('x-request-id', id);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return failure(error, 503, id); }
  finally { await server.close(); }
}
