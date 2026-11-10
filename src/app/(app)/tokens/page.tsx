import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { listTokens } from '../../../domain/credentials';
import { listProjects } from '../../../domain/projects';
import type { TokenScope } from './copy';
import { CreateTokenForm, TokenList, type ProjectChoice, type TokenView } from './forms';
import { classifyFailure, requireOwner } from './guard';
import { PageShell } from './shell';

export const dynamic = 'force-dynamic';

function scopeOf(value: string): TokenScope {
  return value === 'org' ? 'org' : 'projects';
}

export default async function TokensPage() {
  await connection();
  const principal = await requireOwner();
  let failure: string | undefined;
  let missing = false;
  let projects: ProjectChoice[] = [];
  let views: TokenView[] = [];
  try {
    const [tokens, named, choices] = await Promise.all([
      listTokens(principal),
      listProjects(principal, { includeArchived: true }),
      listProjects(principal),
    ]);
    const names = new Map(named.map((project) => [project.id, project.name]));
    projects = choices.map((project) => ({ id: project.id, name: project.name }));
    views = tokens.map((token) => ({
      id: token.id,
      label: token.label,
      prefix: token.prefix,
      scope: scopeOf(token.scope),
      projectIds: token.projectIds,
      projectNames: token.projectIds.map((id) => names.get(id) ?? 'Unavailable project'),
      canCreateProjects: token.canCreateProjects,
      expiresAt: token.expiresAt,
      revokedAt: token.revokedAt,
      lastUsedAt: token.lastUsedAt,
    }));
  } catch (error) {
    const classified = classifyFailure(error);
    if (classified === 'missing') missing = true;
    else failure = classified.message;
  }
  if (missing) notFound();
  if (failure) return <PageShell title="Tokens"><p role="alert">{failure}</p></PageShell>;
  return <PageShell title="Tokens">
    <section aria-label="Create a token" className="space-y-4">
      <h2 className="text-xl font-semibold">Create a token</h2>
      <CreateTokenForm projects={projects} />
    </section>
    <section aria-label="Token list" className="space-y-4">
      <h2 className="text-xl font-semibold">Your tokens</h2>
      <TokenList tokens={views} projects={projects} />
    </section>
  </PageShell>;
}
