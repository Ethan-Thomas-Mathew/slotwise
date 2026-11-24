import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes from the OS's secure random generator, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** We store only this hash of a token; the raw token lives in the cookie/email link. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares two secrets in constant time (no early exit that leaks timing). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
