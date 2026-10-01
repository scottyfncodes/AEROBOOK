/**
 * Who may do what. Three roles, each with everything the one below has:
 *
 *   user       works with all the data
 *   admin      also manages people's accounts
 *   developer  also decides who is an admin or a developer, and is the only
 *              one who may manage a developer's account
 *
 * Shared by the app and the server, so it imports nothing.
 */
export type Role = 'developer' | 'admin' | 'user';

/** Roles only a developer may give or take away. */
export const PRIVILEGED_ROLES: readonly Role[] = ['developer', 'admin'];

/**
 * The role a stored value means. Better Auth keeps several roles as a
 * comma-separated list; the highest one counts. Anything unknown is a user.
 */
export function toRole(stored: string | null | undefined): Role {
  const roles = (stored ?? '').split(',').map((r) => r.trim());
  if (roles.includes('developer')) return 'developer';
  if (roles.includes('admin')) return 'admin';
  return 'user';
}

/** Manages accounts: an admin, or a developer. */
export function isAdmin(user: { role: Role }): boolean {
  return user.role === 'admin' || user.role === 'developer';
}

export function isDeveloper(user: { role: Role }): boolean {
  return user.role === 'developer';
}

export const ROLE_LABEL: Record<Role, string> = { developer: 'Developer', admin: 'Admin', user: 'User' };

/** "a developer", "an admin", "a user". */
export function withArticle(role: Role): string {
  return role === 'admin' ? 'an admin' : `a ${role}`;
}
