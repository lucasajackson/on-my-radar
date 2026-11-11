/**
 * Organizations: the read model (migration 0089).
 *
 * Every user has one home organization and may belong to others. These are reads only.
 * Nothing here decides who can see a radar: that stays in `access.ts`. What an
 * organization's administrators get is people and counts: names, roles and how many,
 * never a blip, a comment, a brief or a memory.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';
import { notFound, type Actor } from '../http.js';

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'guest';

export type OrganizationSummary = {
  id: string;
  kind: 'personal' | 'install' | 'team';
  name: string;
  slug: string;
};

export type OrganizationMember = {
  userId: string;
  name: string | null;
  email: string;
  role: OrganizationRole;
  isHome: boolean;
  deactivated: boolean;
};

export type OrganizationMembers = {
  members: OrganizationMember[];
  counts: { total: number; active: number; deactivated: number } & Record<OrganizationRole, number>;
};

/** The organization a user's own things are filed under. Null only for a user that does not exist. */
export async function homeOrganization(userId: string): Promise<OrganizationSummary | null> {
  const [row] = await getDb()
    .select({
      id: schema.organizations.id,
      kind: schema.organizations.kind,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.isHome, true)));
  return row ?? null;
}

/**
 * The people in an organization, for its owners and admins. Anyone else, an agent, or an
 * organization that does not exist all get the same 404, so the answer never confirms that
 * an organization is there.
 */
export async function organizationMembers(
  actor: Actor | null,
  orgId: string,
): Promise<OrganizationMembers> {
  if (actor?.kind !== 'user') throw notFound('Organization not found');
  const db = getDb();
  const [mine] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.orgId, orgId),
        eq(schema.memberships.userId, actor.user.id),
        isNull(schema.memberships.deactivatedAt),
      ),
    );
  if (mine?.role !== 'owner' && mine?.role !== 'admin') throw notFound('Organization not found');

  const rows = await db
    .select({
      userId: schema.memberships.userId,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.memberships.role,
      isHome: schema.memberships.isHome,
      deactivated: sql<boolean>`${schema.memberships.deactivatedAt} IS NOT NULL`,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.orgId, orgId))
    .orderBy(asc(schema.users.email));

  const counts: OrganizationMembers['counts'] = {
    total: rows.length,
    active: 0,
    deactivated: 0,
    owner: 0,
    admin: 0,
    member: 0,
    guest: 0,
  };
  for (const row of rows) {
    counts[row.role] += 1;
    counts[row.deactivated ? 'deactivated' : 'active'] += 1;
  }
  return { members: rows, counts };
}
