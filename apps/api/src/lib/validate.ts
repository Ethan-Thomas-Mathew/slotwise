import type { z } from 'zod';
import { ZodError } from 'zod';

/** Parses untrusted input. A ZodError becomes a 400 VALIDATION_ERROR in the error handler. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  return schema.parse(data);
}

/**
 * Validates OUR OWN response before sending it. If this fails it's a server
 * bug (500), not the client's fault, so we don't let it surface as a 400.
 */
export function respond<T extends z.ZodType>(schema: T, data: z.input<T>): z.output<T> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Response failed validation: ${JSON.stringify(err.issues)}`);
    }
    throw err;
  }
}

export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
