'use server';

import { revalidatePath } from 'next/cache';
import { createProject } from '../../../domain/projects';
import { actionFailure, ownerPrincipal } from '../session';

export type ProjectFormState = { message: string; field?: string };

export async function createProjectAction(_state: ProjectFormState, data: FormData): Promise<ProjectFormState> {
  const principal = await ownerPrincipal();
  const name = text(data, 'name');
  const slug = text(data, 'slug');
  const description = text(data, 'description');
  const idempotencyKey = text(data, 'idempotencyKey');
  if (!idempotencyKey) return { message: 'Reload the page and try again.', field: 'idempotencyKey' };
  try {
    await createProject(principal, {
      name,
      slug,
      description: description.length > 0 ? description : undefined,
      idempotencyKey,
    });
  } catch (error) {
    const failure = actionFailure(error);
    return { message: failure.message, field: failure.field };
  }
  revalidatePath('/projects');
  revalidatePath('/');
  return { message: 'Project created.' };
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? '').trim();
}
