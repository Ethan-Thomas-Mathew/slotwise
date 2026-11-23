import type { FastifyBaseLogger } from 'fastify';

/**
 * Side effects (queueing jobs) that must happen only AFTER the database
 * transaction commits. If we queued inside the transaction and it then rolled
 * back, a worker could act on a change that never happened.
 *
 * If queueing fails after commit, nothing is lost: the state is already in the
 * database (e.g. a PENDING notification row) and the reconciler job picks it up.
 */
export type Effects = Array<() => Promise<unknown>>;

export async function runEffects(effects: Effects, log?: FastifyBaseLogger) {
  for (const effect of effects) {
    try {
      await effect();
    } catch (err) {
      (log ?? console).warn(
        { err },
        'Post-commit side effect failed; the reconciler will retry it',
      );
    }
  }
}
