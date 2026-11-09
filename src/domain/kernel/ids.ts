import { v7 as uuidv7 } from 'uuid';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** App-side UUIDv7. Postgres 16 has no uuidv7(), and PG18's function is off limits (D-002). */
export function newId(): string {
  return uuidv7();
}

export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}
