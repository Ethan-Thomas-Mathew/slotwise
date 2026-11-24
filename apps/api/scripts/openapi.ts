/**
 * Writes docs/openapi.json from the route schemas:  pnpm --filter @slotwise/api openapi
 * The file is committed so API changes show up in code review; a test fails if
 * it is out of date.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from '../src/openapi/spec';

const out = resolve(import.meta.dirname, '../../../docs/openapi.json');
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2) + '\n');
console.log(`Wrote ${out}`);
