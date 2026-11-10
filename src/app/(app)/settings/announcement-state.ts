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
