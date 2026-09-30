/**
 * The database schema — Better Auth's tables and AEROBOOK's.
 *
 *   npm run db:migrate        create or update the tables at DATABASE_URL
 *   npm run db:schema         print the SQL instead, to apply by hand
 *
 * Printing needs a database to compare against; point DATABASE_URL at an
 * empty one to get the full schema.
 */
import { migrate, schemaSql } from '../server/auth.js';
import { resetPool } from '../server/db.js';

process.env.BETTER_AUTH_SECRET ??= 'only-used-to-build-the-schema-not-to-sign-anything';
if (process.argv.includes('--print')) console.log(await schemaSql());
else {
  await migrate();
  console.log('Schema is up to date.');
}
await resetPool();
