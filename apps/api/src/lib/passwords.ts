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

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
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
