-- Two-step sign-in for admins (Better Auth's two-factor plugin).
--
-- Additive only: one column on "user", one new table. Safe to run more than
-- once, and safe for the code already deployed, which ignores both. Apply it
-- to a database before deploying the code that uses it; that code checks the
-- schema when it starts and refuses to serve without them.
--
-- The secret and the backup codes are stored encrypted with
-- BETTER_AUTH_SECRET, never in the clear.
begin;

alter table "user" add column if not exists "twoFactorEnabled" boolean default false;

create table if not exists "twoFactor" (
  "id" text not null primary key,
  "secret" text not null,
  "backupCodes" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "verified" boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamptz
);

create index if not exists "twoFactor_secret_idx" on "twoFactor" ("secret");
create index if not exists "twoFactor_userId_idx" on "twoFactor" ("userId");

commit;
