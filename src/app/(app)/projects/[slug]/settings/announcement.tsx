import { Markdown } from '../../../../../components/markdown/Markdown';
import { getProjectAnnouncement, listProjectAnnouncementRevisions } from '../../../../../domain/announcements';
import type { HumanPrincipal } from '../../../../../domain/kernel';
import { AnnouncementEditor } from '../../../settings/editor';
import { RevisionHistory } from '../../../settings/history';
import { clearProjectAnnouncementAction, saveProjectAnnouncement } from './announcement-actions';

export async function ProjectAnnouncementSettings({ principal, projectId, slug }: { principal: HumanPrincipal; projectId: string; slug: string }) {
  const live = await getProjectAnnouncement(principal, projectId);
  const history = await listProjectAnnouncementRevisions(principal, { projectId });
  const revisions = history.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), clearedAt: row.clearedAt?.toISOString() ?? null }));
  return <section aria-label="Project announcement settings" className="space-y-6">
    <h2 className="text-xl font-semibold">Project announcement</h2>
    <section aria-label="Current project announcement" className="space-y-2 rounded border p-4">
      <h3 className="font-medium">Current project announcement</h3>
      {live ? <><p>Version {live.version} · Human, {live.authorDisplayName} · <time dateTime={live.updatedAt.toISOString()}>{live.updatedAt.toISOString()}</time></p>
        <h4>{live.title}</h4><Markdown>{live.body}</Markdown></> : <p>No project announcement.</p>}
    </section>
    <AnnouncementEditor expectedVersion={live?.version ?? history[0]?.version ?? 0}
      initialTitle={live?.title ?? ''} initialBody={live?.body ?? ''} canClear={live !== null}
      saveAction={saveProjectAnnouncement.bind(null, slug)} clearAction={clearProjectAnnouncementAction.bind(null, slug)} />
    <RevisionHistory revisions={revisions} />
  </section>;
}
