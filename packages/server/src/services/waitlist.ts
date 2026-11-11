/**
 * The marketing site's waitlist form, joined to the queue approval already
 * works on. `docs/DESIGN.md` §14 is the long version; `drizzle/0037` says why
 * it is a pending user with a side table rather than a queue of its own.
 *
 * This is the one unauthenticated endpoint that sends mail to an address the
 * caller chose, so everything below is shaped by that:
 *
 * - **One answer.** A new address, one already queued, an existing account, a
 *   honeypot hit — the caller gets the same response for all of them, and the
 *   mail goes through the outbox after the response, so how long the request
 *   took does not say which it was either.
 * - **One confirmation per address per day**, charged in the same statement
 *   that decides to send it, and **never** one to an account that is already
 *   in: an active or suspended person is not "on the list", and telling them
 *   so is either wrong or a nuisance somebody else pointed at them.
 * - **A per-network ceiling** on submissions, from the edge's trusted header
 *   only (`clientIp`).
 *
 * And it never lets anybody in. A form submission proves nothing about who
 * owns the address, so it can only ever create the state a first sign-in
 * would — `pending` — and it creates nothing at all for an address that a
 * first sign-in would let straight in (an admin, an auto-approved domain, an
 * outstanding admin invitation). Those skip the queue when they sign in, and a
 * pending row made here would take that away: `findOrCreateUser` decides the
 * initial state once, at creation.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  WAITLIST,
  normalizeEmail,
  type WaitlistRequestInput,
  type WaitlistResponseDto,
} from '@onmyradar/contract';
import { accessPolicyFor } from '../auth/accounts.js';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { recordAudit } from './audit.js';
import { invitationBypassFor } from './invites.js';
import { waitlistConfirmationMessage } from './mail.js';
import { drainOne, enqueue } from './outbox.js';

export const WAITLIST_RESPONSE: WaitlistResponseDto = {
  status: 'received',
  message:
    'Thanks — you’re on the list. If this address is new to us, a confirmation is on its way; we’ll email you when your spot is ready.',
};

/** Same answer for every caller once signup is open: there is no list to be on. */
export function openSignupResponse(): WaitlistResponseDto {
  return {
    status: 'received',
    message: `Signup is open — sign in with this address at ${new URL(env().APP_URL).host}/login to get started.`,
  };
}

export function waitlistResponse(): WaitlistResponseDto {
  return env().SIGNUP_MODE === 'open' ? openSignupResponse() : WAITLIST_RESPONSE;
}

/** What happened, for tests and the log. Never returned to the caller. */
export type WaitlistOutcome =
  'honeypot' | 'queued' | 'already-queued' | 'already-in' | 'skips-queue';

export async function joinWaitlist(input: WaitlistRequestInput): Promise<WaitlistOutcome> {
  if (input.website) return 'honeypot';

  const email = normalizeEmail(input.email);
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.users.id, state: schema.users.state })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existing && existing.state !== 'pending') return 'already-in';
  if (!existing) {
    const policy = accessPolicyFor(email);
    if (policy.state === 'active' || (await invitationBypassFor(email))) return 'skips-queue';
  }

  const { outcome, mailJob } = await db.transaction(
    async (tx): Promise<{ outcome: WaitlistOutcome; mailJob: string | null }> => {
      let userId = existing?.id ?? null;
      let created = false;
      if (!userId) {
        const [row] = await tx
          .insert(schema.users)
          .values({ email, state: 'pending' })
          // Two submissions — or a submission and a first sign-in — racing for
          // the same address: the unique index decides, and the loser reads the
          // winner's row, whatever state it chose.
          .onConflictDoNothing({ target: schema.users.email })
          .returning({ id: schema.users.id });
        if (row) {
          userId = row.id;
          created = true;
        } else {
          const [raced] = await tx
            .select({ id: schema.users.id, state: schema.users.state })
            .from(schema.users)
            .where(eq(schema.users.email, email))
            .limit(1);
          if (!raced || raced.state !== 'pending') return { outcome: 'already-in', mailJob: null };
          userId = raced.id;
        }
      }

      // First submission's details win: a later one — possibly somebody else
      // typing this address — only records that it asked again.
      await tx
        .insert(schema.waitlistRequests)
        .values({
          userId,
          name: input.name,
          useCase: input.useCase ?? null,
          source: input.source ?? null,
        })
        .onConflictDoUpdate({
          target: schema.waitlistRequests.userId,
          set: { lastRequestedAt: sql`now()` },
        });

      // The throttle and the decision to send are one statement: two requests
      // arriving together cannot both find the slot free.
      const [slot] = await tx
        .update(schema.waitlistRequests)
        .set({ confirmationSentAt: sql`now()` })
        .where(
          and(
            eq(schema.waitlistRequests.userId, userId),
            or(
              isNull(schema.waitlistRequests.confirmationSentAt),
              lt(
                schema.waitlistRequests.confirmationSentAt,
                sql`now() - ${WAITLIST.confirmationIntervalHours} * interval '1 hour'`,
              ),
            ),
          ),
        )
        .returning({ name: schema.waitlistRequests.name });
      const mailJob = slot
        ? await enqueue(tx, 'email', { ...waitlistConfirmationMessage(email, slot.name) })
        : null;
      if (created) {
        await recordAudit(
          null,
          'user.waitlist',
          'user',
          userId,
          {
            via: 'form',
            ...(input.source ? { source: input.source } : {}),
          },
          tx,
        );
      }
      return { outcome: created ? 'queued' : 'already-queued', mailJob };
    },
  );

  if (mailJob) void drainOne(mailJob).catch(() => undefined);
  logger.info({ outcome }, 'waitlist request');
  return outcome;
}
