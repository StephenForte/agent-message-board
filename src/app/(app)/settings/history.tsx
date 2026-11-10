import { Markdown } from '../../../components/markdown/Markdown';

export type RevisionView = {
  version: number;
  title: string;
  body: string;
  authorDisplayName: string;
  createdAt: string;
  clearedAt: string | null;
};

export function RevisionHistory({ revisions }: { revisions: RevisionView[] }) {
  return <section aria-labelledby="revision-history" className="space-y-3">
    <h2 id="revision-history" className="text-xl font-medium">Revision history</h2>
    {revisions.length === 0 ? <p>No revisions yet.</p> : <ol className="space-y-4">{revisions.map((revision) => <li key={revision.version} className="space-y-2 rounded border p-4">
      <p>Version {revision.version} · {revision.clearedAt ? 'Cleared' : 'Published'} · Human, {revision.authorDisplayName} · {revision.createdAt}</p>
      <h3 className="font-medium">{revision.title}</h3>
      {revision.body ? <Markdown>{revision.body}</Markdown> : <p>No body.</p>}
    </li>)}</ol>}
  </section>;
}
