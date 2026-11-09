// Shared by auth configuration and operational route redaction. No runtime secrets here.
export const AUTH_BASE_PATH = '/api/auth';
export const credentialPathPrefixes = ['/activate/', `${AUTH_BASE_PATH}/reset-password/`] as const;
