import { notFound } from 'next/navigation';
import { requireAdmin } from '../../../auth/web';
import { Markdown } from '../../../components/markdown/Markdown';
import { listAnnouncementRevisions } from '../../../domain/announcements';
import { DomainError } from '../../../domain/kernel';
import { AnnouncementEditor } from '../../(app)/settings/editor';
import { RevisionHistory, type RevisionView } from '../../(app)/settings/history';
import { clearSiteAnnouncementAction, saveSiteAnnouncement } from './actions';

export const dynamic = 'force-dynamic';

export default async function SiteAnnouncementPage() {
  const principal = await requireAdmin();
  let revisions: RevisionView[] = [];
  try {
    const history = await listAnnouncementRevisions(principal, { scope: 'site', limit: 20 });
    revisions = history.map((revision) => ({
      version: revision.version,
      title: revision.title,
      body: revision.body,
      authorDisplayName: revision.authorDisplayName,
      createdAt: revision.createdAt.toISOString(),
      clearedAt: revision.clearedAt ? revision.clearedAt.toISOString() : null,
    }));
  } catch (error) {
    if (error instanceof DomainError && error.code === 'forbidden_or_not_found') notFound();
    throw new Error('The page could not be loaded.');
  }
  const newest = revisions[0] ?? null;
  const live = newest && !newest.clearedAt ? newest : null;
  return <div className="space-y-8">
    <h1 className="text-2xl font-semibold">Site announcement</h1>
    <section aria-labelledby="current-site-announcement" className="space-y-2 rounded border p-4">
      <h2 id="current-site-announcement" className="text-xl font-medium">Current site announcement</h2>
      {live ? <>
        <p>Version {live.version} · Human, {live.authorDisplayName}</p>
        <h3 className="font-medium">{live.title}</h3>
        {live.body ? <Markdown>{live.body}</Markdown> : <p>No body.</p>}
      </> : <p>No site announcement.</p>}
    </section>
    <AnnouncementEditor
      expectedVersion={newest?.version ?? 0}
      initialTitle={live?.title ?? ''}
      initialBody={live?.body ?? ''}
      canClear={live !== null}
      saveAction={saveSiteAnnouncement}
      clearAction={clearSiteAnnouncementAction}
    />
    <RevisionHistory revisions={revisions} />
  </div>;
}
