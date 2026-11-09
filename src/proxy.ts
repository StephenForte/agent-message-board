import { NextResponse, type NextRequest } from 'next/server';
import { requestId } from './lib/log';

export function proxy(request: NextRequest) {
  const id = requestId(request.headers.get('x-request-id'));
  const headers = new Headers(request.headers);
  headers.set('x-request-id', id);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-request-id', id);
  return response;
}
