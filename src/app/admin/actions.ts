'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../auth/web';
import { DomainError } from '../../domain/kernel';
import {
  associateOwner, issueOwnerActivation, provisionOrganization, restoreOrganization,
  setOrganizationSlug, suspendOrganization,
} from '../../domain/organizations';
import { loadEnv } from '../../env';

export type AdminResult = { message: string; field?: string; activationUrl?: string };

function text(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

function orgPaths(id: string) {
  revalidatePath('/admin');
  revalidatePath(`/admin/organizations/${id}`);
}

function fieldForReason(reason: string): string | undefined {
  const lower = reason.toLowerCase();
  if (lower.includes('email') || lower.includes('verified user') || lower.includes('already owns')) return 'email';
  if (lower.includes('public address')) return 'slug';
  if (lower.includes('name')) return 'name';
  return undefined;
}

async function catchAdmin(error: unknown, fallbackField?: string): Promise<AdminResult> {
  if (error instanceof DomainError && error.code === 'forbidden_or_not_found') {
    // A revoked role gets the same server-side 404 as any other non-admin.
    await requireAdmin();
    return { message: 'Organization unavailable.' };
  }
  if (error instanceof DomainError && error.code === 'validation_failed') {
    const reason = typeof error.details.reason === 'string' ? error.details.reason : 'Check your input.';
    const field = typeof error.details.field === 'string' ? error.details.field : fieldForReason(reason) ?? fallbackField;
    return { message: reason, field };
  }
  throw new Error('Organization update unavailable. Please try again.');
}

export async function createOrganization(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const email = text(data, 'email').trim();
  let createdId = '';
  try {
    const org = await provisionOrganization(principal, { name: text(data, 'name'), ownerEmail: email || undefined });
    createdId = org.id;
  } catch (error) {
    return catchAdmin(error);
  }
  orgPaths(createdId);
  redirect(`/admin/organizations/${createdId}`);
}

export async function setOwner(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const id = text(data, 'id');
  try {
    await associateOwner(principal, id, text(data, 'email'));
  } catch (error) {
    return catchAdmin(error, 'email');
  }
  orgPaths(id);
  return { message: 'Owner set.' };
}

export async function createInviteLink(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const id = text(data, 'id');
  try {
    const issued = await issueOwnerActivation(principal, id, text(data, 'email'));
    orgPaths(id);
    return {
      message: 'Copy this invite link now. It expires in 72 hours and will not be displayed again.',
      activationUrl: new URL(`/activate/${issued.token}`, loadEnv().APP_BASE_URL).toString(),
    };
  } catch (error) {
    return catchAdmin(error, 'email');
  }
}

export async function savePublicAddress(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const id = text(data, 'id');
  try {
    await setOrganizationSlug(principal, id, text(data, 'slug'));
  } catch (error) {
    return catchAdmin(error, 'slug');
  }
  orgPaths(id);
  return { message: 'Public address saved.' };
}

export async function suspendOrganizationAction(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const id = text(data, 'id');
  try {
    await suspendOrganization(principal, id);
  } catch (error) {
    return catchAdmin(error);
  }
  orgPaths(id);
  return { message: 'Organization suspended.' };
}

export async function restoreOrganizationAction(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const id = text(data, 'id');
  try {
    await restoreOrganization(principal, id);
  } catch (error) {
    return catchAdmin(error);
  }
  orgPaths(id);
  return { message: 'Organization restored.' };
}
