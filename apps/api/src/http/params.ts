import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from './errors';

const uuid = z.uuid();

/**
 * Reads a UUID route parameter. A malformed id is treated as "not found"
 * (it can't exist), never passed to the database.
 */
export function idParam(req: FastifyRequest, name = 'id', what = 'Resource'): string {
  const value = (req.params as Record<string, string | undefined>)[name];
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw notFound(what);
  return parsed.data;
}
