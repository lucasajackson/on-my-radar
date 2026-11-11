/**
 * What a caller with **no grant** on a radar is allowed to see.
 *
 * A public link is the one way to read a radar without holding a role on it,
 * and everything it hands over has to be narrower than what a member gets:
 * owner ids, member counts and author addresses are about the *people* around a
 * radar, and publishing a radar is a decision about its contents.
 *
 * This used to live in `routes/public.ts` as three local mappers, which made it
 * a property of one transport rather than of the access. The private routes and
 * the MCP tools accept a `public_slug` as an identifier — `requireRadar` has to
 * take one, or the thread on a published blip is unreachable — so the same
 * radar read through `/api/radars/<slug>` came back unredacted, member list and
 * all. Narrowing is decided here, from `role === null`, and applied by the
 * services every transport shares.
 *
 * `role === null` rather than `viaPublicLink` on purpose: `canRead` is true for
 * exactly two kinds of caller, somebody with a role and somebody on a public
 * link, so the absence of a role is the whole of the condition and cannot fall
 * out of step with the flag that explains it.
 */
import type { AgentDto, BlipDto, CommentDto, MentionDto, RadarDto } from '@onmyradar/contract';
import type { RadarAccess } from './access.js';

/** True when the caller reached this radar without any grant on it. */
export function isPublicOnly(access: Pick<RadarAccess, 'role'>): boolean {
  return access.role === null;
}

/**
 * The owner's name survives; their id and address do not.
 *
 * A public page says who wrote it — that is attribution, and a radar with no
 * author reads as unowned rather than as private. `memberCount` goes to zero
 * because how many people a radar is shared with is not a fact about the
 * radar's contents, and it is exactly the fact that makes a member list worth
 * enumerating.
 *
 * The topic goes too. A topic is how the owner organises their own radars and
 * it has no public surface at all — its name ("Acquisition plans") is often the
 * most private string in the account, and publishing one radar is not a
 * decision to publish the folder it sits in.
 */
export function narrowRadar(radar: RadarDto): RadarDto {
  return {
    ...radar,
    ownerId: '',
    owner: radar.owner ? { id: '', name: radar.owner.name, email: '' } : null,
    memberCount: 0,
    topicId: null,
    topic: null,
  };
}

/**
 * A mention names an account, and an account id is an id like any other here.
 * The handle and the display name stay — they are already in the body the
 * caller can read, so blanking them would print `@ada` beside "someone" and
 * read as a fault rather than as privacy.
 */
export function narrowMentions(mentions: MentionDto[]): MentionDto[] {
  return mentions.map((mention) => ({
    ...mention,
    userId: '',
    // An agent id is an id like any other here. The handle and the name stay for
    // the same reason a person's do: they are already in the body the caller can
    // read, so blanking them would print `@claude` beside "someone".
    ...(mention.agentId === undefined ? {} : { agentId: '' }),
  }));
}

/**
 * The agent's name survives; its id does not — exactly the rule the author
 * beside it already follows.
 *
 * A public reader learns that a thought came from an agent and what it is
 * called, which is attribution and is the honest thing to say. They learn no id
 * and nothing about who owns it: `agents.owner_id` never reaches the wire at
 * all, so there is nothing here to blank, which is the same argument as
 * `MentionDto` carrying no address.
 */
function narrowAgent(agent: AgentDto | null): AgentDto | null {
  return agent ? { ...agent, id: '' } : null;
}

/** Attachment hrefs are left alone: they are a routing concern, not a person. */
export function narrowBlip(blip: BlipDto): BlipDto {
  // A client's name and the helpdesk clock never leave a signed-in view. A
  // helpdesk is never public (HELPDESK §6.1), so this is the last fence.
  const {
    reminder: _reminder,
    email,
    mentions,
    external: _external,
    awaitingClientSince: _awaiting,
    lastEditedBy: _editedBy,
    lastMovedBy: _movedBy,
    ...publicBlip
  } = blip;
  const narrowed: BlipDto = {
    ...publicBlip,
    author: blip.author ? { id: '', name: blip.author.name, email: '' } : null,
    agent: narrowAgent(blip.agent),
  };
  if (email) narrowed.email = { ...email, senderAddress: null };
  if (mentions) narrowed.mentions = narrowMentions(mentions);
  return narrowed;
}

/**
 * `canDelete` is forced false rather than trusted: a caller with no role can
 * never act on a comment, and a button that 403s is worse than no button.
 */
export function narrowComment(comment: CommentDto): CommentDto {
  const { mentions, external: _external, editedBy: _editedBy, ...rest } = comment;
  const narrowed: CommentDto = {
    ...rest,
    radarId: '',
    author: comment.author ? { id: '', name: comment.author.name, email: '' } : null,
    agent: narrowAgent(comment.agent),
    canDelete: false,
  };
  if (mentions) narrowed.mentions = narrowMentions(mentions);
  return narrowed;
}
