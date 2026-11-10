export type AnnouncementFormState = {
  message: string;
  field?: string;
  version?: number;
  cleared?: boolean;
  conflict?: { currentVersion: number; stateLabel: string };
  draftTitle?: string;
  draftBody?: string;
};

export const emptyAnnouncementState: AnnouncementFormState = { message: '' };

export type EditorAction = 'save' | 'clear';

export type EditorNotice =
  | { role: 'alert' | 'status'; message: string }
  | { role: 'field'; field: 'title' | 'body'; message: string };

/** The newest submit owns the notice. An older clear or conflict must not stay on screen. */
export function editorNotice(
  latest: EditorAction | null,
  save: AnnouncementFormState,
  clear: AnnouncementFormState,
): EditorNotice | null {
  if (latest === 'clear') return clear.message ? { role: 'status', message: clear.message } : null;
  if (latest !== 'save' || !save.message) return null;
  if (save.conflict) return { role: 'alert', message: save.message };
  if (save.field === 'title' || save.field === 'body') return { role: 'field', field: save.field, message: save.message };
  if (save.field) return null;
  return { role: 'status', message: save.message };
}
