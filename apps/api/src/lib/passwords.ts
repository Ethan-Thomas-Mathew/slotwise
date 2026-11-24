import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with Argon2id (the current OWASP recommendation), via the
 * maintained @node-rs/argon2 library. We never write hashing code ourselves.
 * Each hash includes its own random salt and parameters, so `verify` needs
 * nothing but the stored string.
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/**
 * Stored for an account that can never log in with a password (an erased account).
 * Any value starting with "!" is treated the same way.
 */
export const UNUSABLE_PASSWORD_HASH = '!erased';

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (storedHash.startsWith('!')) return false;
  // Anything else must be a valid Argon2 hash; if it isn't, that's data corruption
  // worth an error, not a silent "wrong password".
  return verify(storedHash, password);
}

/**
 * Used when the email doesn't exist, so a failed login takes about as long
 * either way and attackers can't detect which emails are registered by timing.
 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password-just-for-timing');
  await verifyPassword(await dummyHash, password);
}
