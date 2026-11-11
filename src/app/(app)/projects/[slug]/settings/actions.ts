'use server';

import { revalidatePath } from 'next/cache';
import { archiveProject, getProjectBySlug, restoreProject, setProjectVisibility, updateProject } from '../../../../../domain/projects';
import { actionFailure, ownerPrincipal } from '../../../session';

export type ProjectSettingsState = { message: string; field?: string };

export async function renameProject(slug: string, _state: ProjectSettingsState, data: FormData): Promise<ProjectSettingsState> {
  const principal = await ownerPrincipal();
  const name = String(data.get('name') ?? '').trim();
  const description = String(data.get('description') ?? '').trim();
  try {
    const project = await getProjectBySlug(principal, slug);
    await updateProject(principal, project.id, { name, description: description.length > 0 ? description : null });
  } catch (error) {
    const failure = actionFailure(error);
    return { message: failure.message, field: failure.field };
  }
  revalidatePath(`/projects/${slug}/settings`);
  revalidatePath('/projects');
  revalidatePath('/');
  return { message: 'Project saved.' };
}

export async function archiveProjectAction(slug: string, previous: ProjectSettingsState): Promise<ProjectSettingsState> {
  void previous;
  return changeStatus(slug, 'archive');
}

export async function restoreProjectAction(slug: string, previous: ProjectSettingsState): Promise<ProjectSettingsState> {
  void previous;
  return changeStatus(slug, 'restore');
}

export async function setVisibility(slug: string, previous: ProjectSettingsState, data: FormData): Promise<ProjectSettingsState> {
  void previous;
  const principal = await ownerPrincipal();
  const visibility = String(data.get('visibility') ?? '');
  if (visibility !== 'public' && visibility !== 'private') return { message: 'Choose public or private.', field: 'visibility' };
  try {
    const project = await getProjectBySlug(principal, slug);
    await setProjectVisibility(principal, project.id, visibility);
  } catch (error) {
    const failure = actionFailure(error);
    return { message: failure.message, field: failure.field };
  }
  revalidatePath(`/projects/${slug}/settings`);
  revalidatePath(`/projects/${slug}`);
  revalidatePath('/projects');
  revalidatePath('/');
  return { message: visibility === 'public' ? 'Project is now public.' : 'Project is now private.' };
}

async function changeStatus(slug: string, operation: 'archive' | 'restore'): Promise<ProjectSettingsState> {
  const principal = await ownerPrincipal();
  try {
    const project = await getProjectBySlug(principal, slug);
    if (operation === 'archive') await archiveProject(principal, project.id);
    else await restoreProject(principal, project.id);
  } catch (error) {
    const failure = actionFailure(error);
    return { message: failure.message };
  }
  revalidatePath(`/projects/${slug}/settings`);
  revalidatePath('/projects');
  revalidatePath('/');
  return { message: operation === 'archive' ? 'Project archived.' : 'Project restored.' };
}
