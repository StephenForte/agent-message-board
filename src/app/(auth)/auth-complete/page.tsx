import { redirect } from 'next/navigation';
import { requireHuman } from '../../../auth/web';
import { humanLanding } from '../../../domain/organizations';
export default async function Complete() { redirect(await humanLanding(await requireHuman())); }
