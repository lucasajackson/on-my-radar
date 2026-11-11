/**
 * What a person may do to a blip, declared once for every client.
 *
 * The second module of the shared UI contract (`docs/UI-CONTRACT.md`). The SPA,
 * the iOS app and whatever comes next all render menus, gestures and
 * confirmations over the same set of verbs; without this each one writes its
 * own list and its own rules about when each verb applies, and they drift.
 *
 * ## The invariant this file exists to hold
 *
 * DESIGN §16 says a gesture may only do reversible things, and that delete is
 * never a swipe. Written as prose, that is a rule somebody has to remember at
 * every call site in every client. Written as a discriminated union — an action
 * is *either* `reversible: true` *or* it carries a `confirm` sentence, never
 * both and never neither — it becomes a shape the compiler checks, and a
 * client's gesture layer is literally `BLIP_ACTIONS.filter((a) => a.reversible)`.
 *
 * ## Three answers, not two
 *
 * Availability is not a boolean. An action can be:
 *
 * - **available** — render it;
 * - **hidden** — this template has no such vocabulary, so the control should
 *   not exist (a microblog has no lanes; there is nothing to say about it);
 * - **blocked** — the vocabulary exists but this person may not use it, and
 *   the interface should say why rather than silently omitting the control.
 *
 * The difference matters: hiding a control somebody could have is confusing,
 * and blocking one that could never exist here is noise.
 *
 * ## What this is not
 *
 * **It is never authorization.** Every predicate reads only booleans the
 * server already resolved onto the DTO — `access.canWrite`, `canDelete` — and
 * never compares an id to a user id. The rule about who may delete a comment
 * lives in `services/access.ts` and this is a rendering hint that agrees with
 * it. A client that computed permission from ids would be a second, drifting
 * copy of the authorization model, which is the exact thing `RadarAccessDto`
 * was created to prevent.
 */

import { templateFor, type TemplateConfig } from './templates.js';
import { advanceTarget, allowsTriageGesture, deferTarget } from './triage.js';

/**
 * An icon by meaning, not by asset. Every client maps these to its own set —
 * SF Symbols on iOS, lucide on the web — because an asset name is a platform
 * fact and the *meaning* is not.
 */
export type IconToken =
  | 'advance'
  | 'defer'
  | 'pin'
  | 'unpin'
  | 'edit'
  | 'move'
  | 'delete'
  | 'react'
  | 'share'
  | 'comment';

export type BlipActionId =
  | 'advance'
  | 'defer'
  | 'pin'
  | 'unpin'
  | 'edit'
  | 'move'
  | 'react'
  | 'comment'
  | 'share'
  | 'delete';

interface ActionBase {
  readonly id: BlipActionId;
  /** The verb on the control. Overridden per-blip for triage, which reads its lane. */
  readonly label: string;
  readonly icon: IconToken;
  /** True when this action changes stored state, so a client knows to refetch. */
  readonly mutates: boolean;
}

/**
 * Reversible actions may ride a gesture and must offer an undo. Irreversible
 * ones may not ride a gesture and must ask first. The union is what makes
 * "delete is never a swipe" unrepresentable rather than merely forbidden.
 */
export type BlipActionDef =
  | (ActionBase & {
      readonly reversible: true;
      /** Past tense, for the undo toast: "Done", "Pinned", "Moved". */
      readonly acknowledgement: string;
      readonly confirm?: never;
    })
  | (ActionBase & {
      readonly reversible: false;
      readonly acknowledgement: string;
      /** The sentence a person agrees to. Its presence is what forbids the gesture. */
      readonly confirm: string;
    });

export const BLIP_ACTIONS = [
  {
    id: 'advance',
    label: 'Done',
    acknowledgement: 'Done',
    icon: 'advance',
    reversible: true,
    mutates: true,
  },
  {
    id: 'defer',
    label: 'Later',
    acknowledgement: 'Put off',
    icon: 'defer',
    reversible: true,
    mutates: true,
  },
  {
    id: 'pin',
    label: 'Pin',
    acknowledgement: 'Pinned',
    icon: 'pin',
    reversible: true,
    mutates: true,
  },
  {
    id: 'unpin',
    label: 'Unpin',
    acknowledgement: 'Unpinned',
    icon: 'unpin',
    reversible: true,
    mutates: true,
  },
  {
    id: 'edit',
    label: 'Edit',
    acknowledgement: 'Edited',
    icon: 'edit',
    reversible: true,
    mutates: true,
  },
  {
    id: 'move',
    label: 'Move to…',
    acknowledgement: 'Moved',
    icon: 'move',
    reversible: true,
    mutates: true,
  },
  {
    id: 'react',
    label: 'React',
    acknowledgement: 'Reacted',
    icon: 'react',
    reversible: true,
    mutates: true,
  },
  {
    id: 'comment',
    label: 'Comment',
    acknowledgement: 'Replied',
    icon: 'comment',
    reversible: true,
    mutates: true,
  },
  {
    id: 'share',
    label: 'Share',
    acknowledgement: 'Shared',
    icon: 'share',
    reversible: true,
    mutates: false,
  },
  {
    id: 'delete',
    label: 'Delete',
    acknowledgement: 'Deleted',
    icon: 'delete',
    reversible: false,
    // One sentence, and it names what is lost rather than asking "are you sure".
    confirm: 'Delete this blip? That cannot be undone.',
    mutates: true,
  },
] as const satisfies readonly BlipActionDef[];

export type BlipActionDefinition = (typeof BLIP_ACTIONS)[number];

export function blipAction(id: BlipActionId): BlipActionDefinition {
  const found = BLIP_ACTIONS.find((action) => action.id === id);
  // Not reachable through the type, and a throw here would take a card down
  // over a menu entry. The advance action is the harmless answer.
  return found ?? BLIP_ACTIONS[0];
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

export type ActionAvailability =
  | { readonly state: 'available'; readonly label: string }
  /** No such vocabulary here. Render nothing at all. */
  | { readonly state: 'hidden' }
  /** It exists, but not for you. Say so rather than hiding it. */
  | { readonly state: 'blocked'; readonly reason: string };

/**
 * Everything an availability decision may read.
 *
 * Deliberately narrow, and deliberately all server-resolved: a caller cannot
 * pass a user id because no predicate here is allowed to want one.
 */
export interface ActionContext {
  readonly radar: {
    readonly template: string | null;
    readonly templateConfig?: TemplateConfig | null;
    readonly commentsEnabled: boolean;
    readonly reactionsEnabled: boolean;
    readonly visibility: string;
    readonly access: { readonly canWrite: boolean; readonly canManage: boolean };
  };
  readonly blip: {
    /** A stored state, which a newer build may have written. */
    readonly state: string;
    readonly status?: string | null;
    readonly pinned: boolean;
  };
}

export function actionAvailability(id: BlipActionId, context: ActionContext): ActionAvailability {
  const { radar, blip } = context;
  const definition = blipAction(id);

  switch (id) {
    case 'advance':
    case 'defer': {
      if (!allowsTriageGesture(radar)) return { state: 'hidden' };
      const target =
        id === 'advance'
          ? advanceTarget(radar, { state: blip.state, status: blip.status })
          : deferTarget(radar, { state: blip.state, status: blip.status });
      if (!target) return { state: 'hidden' };
      if (!radar.access.canWrite) {
        return { state: 'blocked', reason: 'You can read this radar but not change it.' };
      }
      return { state: 'available', label: target.label };
    }

    case 'pin':
      if (blip.pinned) return { state: 'hidden' };
      return radar.access.canWrite
        ? { state: 'available', label: definition.label }
        : { state: 'blocked', reason: 'You can read this radar but not change it.' };

    case 'unpin':
      if (!blip.pinned) return { state: 'hidden' };
      return radar.access.canWrite
        ? { state: 'available', label: definition.label }
        : { state: 'blocked', reason: 'You can read this radar but not change it.' };

    case 'edit':
    case 'move':
    case 'delete':
      return radar.access.canWrite
        ? { state: 'available', label: definition.label }
        : { state: 'blocked', reason: 'You can read this radar but not change it.' };

    case 'react':
      // A radar with reactions switched off has no such vocabulary, which is
      // a property of the radar rather than of you.
      if (!radar.reactionsEnabled) return { state: 'hidden' };
      return { state: 'available', label: definition.label };

    case 'comment':
      if (!radar.commentsEnabled) return { state: 'hidden' };
      return { state: 'available', label: templateReplyNoun(radar) };

    case 'share':
      // Sharing a link to a private radar hands over something the recipient
      // cannot open, which reads as a broken link rather than as a refusal.
      return radar.visibility === 'public'
        ? { state: 'available', label: definition.label }
        : { state: 'hidden' };
  }
}

function templateReplyNoun(source: {
  template: string | null;
  templateConfig?: TemplateConfig | null;
}): string {
  const noun =
    templateFor(source.template, source.templateConfig).conversation?.replyNoun ?? 'comment';
  return noun === 'reply' ? 'Reply' : 'Comment';
}

/**
 * The actions a client should draw, in menu order, already resolved.
 *
 * Blocked actions are included so an interface can render them disabled with
 * their reason; a client that only wants the usable ones filters on `state`.
 */
export function availableBlipActions(
  context: ActionContext,
): Array<{ definition: BlipActionDefinition; availability: ActionAvailability }> {
  return BLIP_ACTIONS.map((definition) => ({
    definition,
    availability: actionAvailability(definition.id, context),
  })).filter((entry) => entry.availability.state !== 'hidden');
}

/**
 * The subset a gesture may perform. Reversible by construction, and empty on
 * the templates where a triage gesture would mean the wrong thing.
 */
export function gestureActions(context: ActionContext): BlipActionDefinition[] {
  if (!allowsTriageGesture(context.radar)) return [];
  return BLIP_ACTIONS.filter(
    (action) =>
      action.reversible &&
      (action.id === 'advance' || action.id === 'defer') &&
      actionAvailability(action.id, context).state === 'available',
  );
}
