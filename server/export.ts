/**
 * The company data export: what an admin needs, beyond the records every
 * device already syncs, to take the company's data out of AEROBOOK — the
 * people (so every "who" in the export has a name), the aircraft comments,
 * and the audit log.
 *
 * The package itself is put together in the admin's browser (see
 * src/data/companyExport.ts): records come down through the ordinary sync and
 * documents through /api/files/content, so no single response has to carry
 * every file — a function's response is limited to a few megabytes.
 *
 * Nothing here ever reads a secret: no password hash (it lives in "account",
 * which is never touched), no session, no two-factor secret, no push keys, no
 * environment. Every query names its columns.
 */
import type { SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';
import { recordSecurityEvent } from './security.js';

export const AUDIT_EXPORT_PAGE = 5000;

export interface ExportPerson {
  id: string;
  name: string;
  /** Blank for someone deleted: their address was released. */
  email: string;
  role: 'admin' | 'user';
  access: 'active' | 'off' | 'deleted';
  twoStepSignIn: boolean;
  createdAt: string;
}

export interface ExportComment {
  id: number;
  aircraftId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface ExportAuditEntry {
  id: number;
  at: string;
  userId: string | null;
  userName: string;
  action: string;
  collection: string;
  recordId: string;
  summary: string;
}

function requireAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw new HttpError(403, 'Only an admin can export the company’s data');
}

/** Starts an export: records that it happened, and hands over people and comments. */
export async function startCompanyExport(user: SessionUser): Promise<{
  exportedAt: string;
  exportedBy: { id: string; name: string };
  people: ExportPerson[];
  comments: ExportComment[];
}> {
  requireAdmin(user);
  await ensureAppSchema();
  // Recorded first: an export that fails half-way was still asked for.
  await recordSecurityEvent({ action: 'company-export', userId: user.id, userName: user.name });

  const [people, comments] = await Promise.all([
    getPool().query<{
      id: string; name: string; email: string; role: string | null; banned: boolean | null;
      two_factor: boolean | null; created_at: Date; deleted: boolean;
    }>(
      `select u.id, u.name, u.email, u.role, u.banned, u."twoFactorEnabled" as two_factor, u."createdAt" as created_at,
              exists (select 1 from app_deleted_user d where d.user_id = u.id) as deleted
         from "user" u order by u.name, u.id`,
    ),
    // Deleted comments stay out: someone took them back.
    getPool().query<{
      id: string; aircraft_id: string; author_id: string; author_name: string | null; body: string;
      created_at: Date; edited_at: Date | null;
    }>(
      `select c.id, c.aircraft_id, c.author_id, u.name as author_name, c.body, c.created_at, c.edited_at
         from app_aircraft_comment c left join "user" u on u.id = c.author_id
        where c.deleted_at is null
        order by c.id`,
    ),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    exportedBy: { id: user.id, name: user.name },
    people: people.rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.deleted ? '' : r.email,
      role: r.role === 'admin' ? 'admin' : 'user',
      access: r.deleted ? 'deleted' : r.banned ? 'off' : 'active',
      twoStepSignIn: Boolean(r.two_factor),
      createdAt: r.created_at.toISOString(),
    })),
    comments: comments.rows.map((r) => ({
      id: Number(r.id),
      aircraftId: r.aircraft_id,
      authorId: r.author_id,
      authorName: r.author_name ?? 'Someone',
      body: r.body,
      createdAt: r.created_at.toISOString(),
      editedAt: r.edited_at ? r.edited_at.toISOString() : null,
    })),
  };
}

/**
 * The audit log, oldest first, a page at a time after entry `after`. What a
 * record held before each change (the `before` column) stays out: it is the
 * record itself, already in the export, and would make every page enormous.
 */
export async function companyAuditPage(user: SessionUser, after: number): Promise<{ entries: ExportAuditEntry[]; more: boolean }> {
  requireAdmin(user);
  await ensureAppSchema();
  const { rows } = await getPool().query<{
    id: string; at: Date; user_id: string | null; user_name: string | null; action: string;
    collection: string; record_id: string; summary: string;
  }>(
    `select id, at, user_id, user_name, action, collection, record_id, summary from app_audit
      where id > $1 order by id limit $2`,
    [after, AUDIT_EXPORT_PAGE + 1],
  );
  const more = rows.length > AUDIT_EXPORT_PAGE;
  return {
    entries: rows.slice(0, AUDIT_EXPORT_PAGE).map((r) => ({
      id: Number(r.id),
      at: r.at.toISOString(),
      userId: r.user_id,
      userName: r.user_name ?? '',
      action: r.action,
      collection: r.collection,
      recordId: r.record_id,
      summary: r.summary,
    })),
    more,
  };
}
