import type { SystemTx, TenantTx } from '../../db/tenant-tx';

type AnyTx = SystemTx | TenantTx;

export async function findUserByEmail(tx: AnyTx, email: string) {
  return tx.db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
}

export async function insertUser(
  tx: AnyTx,
  data: { email: string; name: string; passwordHash: string },
) {
  return tx.db
    .insertInto('users')
    .values({ email: data.email.toLowerCase(), name: data.name, password_hash: data.passwordHash })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updatePassword(tx: AnyTx, userId: string, passwordHash: string) {
  await tx.db
    .updateTable('users')
    .set({ password_hash: passwordHash })
    .where('id', '=', userId)
    .execute();
}
