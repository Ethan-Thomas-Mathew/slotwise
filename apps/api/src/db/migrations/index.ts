import type { Migration } from 'kysely';
import * as m0001 from './0001_init';
import * as m0002 from './0002_row_level_security';
import * as m0003 from './0003_auth';
import * as m0004 from './0004_payments';
import * as m0005 from './0005_privacy';

/**
 * Every migration, in order. Listed explicitly (instead of reading the folder at
 * runtime) so the production bundle contains them.
 */
export const migrations: Record<string, Migration> = {
  '0001_init': m0001,
  '0002_row_level_security': m0002,
  '0003_auth': m0003,
  '0004_payments': m0004,
  '0005_privacy': m0005,
};
