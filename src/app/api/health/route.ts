import { checkDatabase } from '../../../domain/kernel/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const ok = await checkDatabase();
  if (!ok) return Response.json({ status: 'unavailable' }, { status: 503 });
  return Response.json({ status: 'ok' });
}
