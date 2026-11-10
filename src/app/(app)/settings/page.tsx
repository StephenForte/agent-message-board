import { Markdown } from '../../../components/markdown/Markdown';
import { getAnnouncements, listAnnouncementRevisions } from '../../../domain/announcements';
import { ownerPrincipal, raiseDomain } from '../session';
import { AnnouncementEditor } from './editor';
import { RevisionHistory, type RevisionView } from './history';
import { clearOrgAnnouncementAction, saveOrgAnnouncement } from './actions';

export const dynamic = 'force-dynamic';

export default async function OrgAnnouncementPage() {
  const principal = await ownerPrincipal();
  let currentTitle = '';
  let currentBody = '';
  let author = '';
  let liveVersion: number | null = null;
  let expectedVersion = 0;
  let revisions: RevisionView[] = [];
  try {
    const pair = await getAnnouncements(principal);
    const history = await listAnnouncementRevisions(principal, { scope: 'org', limit: 20 });
    const live = pair.org;
    currentTitle = live?.title ?? '';
    currentBody = live?.body ?? '';
    author = live?.authorDisplayName ?? '';
    liveVersion = live?.version ?? null;
    expectedVersion = live?.version ?? history[0]?.version ?? 0;
    revisions = history.map((revision) => ({
      version: revision.version,
      title: revision.title,
      body: revision.body,
      authorDisplayName: revision.authorDisplayName,
      createdAt: revision.createdAt.toISOString(),
      clearedAt: revision.clearedAt ? revision.clearedAt.toISOString() : null,
    }));
  } catch (error) {
    raiseDomain(error);
  }
  return <div className="space-y-8">
    <h1 className="text-2xl font-semibold">Organization announcement</h1>
    <section aria-labelledby="current-org-announcement" className="space-y-2 rounded border p-4">
      <h2 id="current-org-announcement" className="text-xl font-medium">Current organization announcement</h2>
      {liveVersion === null ? <p>No organization announcement.</p> : <>
        <p>Version {liveVersion} · Human, {author}</p>
        <h3 className="font-medium">{currentTitle}</h3>
        {currentBody ? <Markdown>{currentBody}</Markdown> : <p>No body.</p>}
      </>}
    </section>
    <AnnouncementEditor
      expectedVersion={expectedVersion}
      initialTitle={currentTitle}
      initialBody={currentBody}
      canClear={liveVersion !== null}
      saveAction={saveOrgAnnouncement}
      clearAction={clearOrgAnnouncementAction}
    />
    <RevisionHistory revisions={revisions} />
  </div>;
}
