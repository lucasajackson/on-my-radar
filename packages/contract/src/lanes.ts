/**
 * Custom lanes — a radar's own vocabulary on a template's behaviour.
 *
 * ## What this is, and what it deliberately is not
 *
 * `docs/TEMPLATES.md` has carried the same warning since the first five
 * templates shipped: *"if you cannot say what a radar on this template lets you
 * do that a stream does not, it is a stream with different words in a dropdown
 * — and it will feel like one."* Pipeline (Lead · Contacted · Proposal · Won ·
 * Lost) and Meeting notes (Agenda · Discussed · Action · Parked) are the two
 * most-asked-for templates and both fail that test outright: they are Kanban
 * with different words. The document's own conclusion was that the answer stops
 * being another template and becomes user-defined lanes.
 *
 * That is this file. A radar keeps a template — which decides layout, order,
 * facets, capture rules, conversation shape and archiving, all of which need
 * code — and may replace the template's **lane vocabulary** with its own.
 *
 * The line is worth stating as a rule, because it is what stops this becoming a
 * plugin system: **a lane set is a vocabulary; a template is a set of
 * behaviours.** Nothing here can add a behaviour. There is no way to express a
 * new sort order, a new card, a new capture rule or a new query, and that is the
 * point — those are the things that need review, tests and a phone layout, and
 * they stay in the registry where they get them.
 *
 * ## Why this is validated rather than free-form
 *
 * `blips.status` has no CHECK constraint in SQL, deliberately, so that shipping
 * a template needs no migration (`docs/DESIGN.md` §4). The vocabulary is
 * therefore enforced *here* and nowhere else, and that was already true before a
 * person could write one. What changes is only who is writing it: an agent,
 * against a radar with blips already filed in the lanes it is about to replace.
 *
 * So the guardrails are not decoration and they are not about taste. Each one
 * below exists because breaking it produces a specific broken radar, and the
 * message says which.
 */

import { BLIP_STATES, type BlipState } from './domain.js';
import {
  CLIENT_FACING_TEMPLATE_IDS,
  RADAR_TEMPLATES,
  RADAR_TEMPLATE_IDS,
  isClientFacingTemplate,
  statusesFor,
  templateFor,
  type BlipStatusDef,
  type RadarTemplate,
} from './templates.js';
import { listWithOr } from './prose.js';
import { CLIENT_STATUSES, isClientStatus } from './helpdesk.js';

/**
 * The bounds, in one object so the rules, the schema, the refusal messages and
 * the MCP guide all read the same numbers.
 *
 * `max` is 8 rather than a rounder number because of the board: a lane has a
 * floor rather than a fixed width, and past eight columns a desktop pane is
 * scrolling horizontally whatever the floor is — see `.board-column` in
 * `styles.css`. On a phone the lane strip becomes a pager, so eight is eight
 * taps to cross the board, which is already more than anybody wants.
 *
 * `min` is 2 because one lane is not an axis. A single-lane board is a stream
 * that has been made to look like work.
 */
export const LANE_LIMITS = {
  min: 2,
  max: 8,
  idMaxLength: 24,
  labelMaxLength: 24,
} as const;

/**
 * What a lane id may be. Lowercase, digits and hyphens, opening on an
 * alphanumeric.
 *
 * Narrow on purpose: this string is stored verbatim in `blips.status`, appears
 * in `read_radar` output, and is what an agent types when it moves a card. A
 * vocabulary that allows spaces, case or punctuation is one where `In Progress`
 * and `in progress` are two lanes and nobody can see the difference on a screen.
 */
export const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** One problem with a proposed lane set, in the words the caller is shown. */
export interface LaneProblem {
  /** Machine-readable, so a client can branch without parsing English. */
  readonly code:
    | 'no-lane-axis'
    | 'too-few'
    | 'too-many'
    | 'bad-id'
    | 'duplicate-id'
    | 'bad-label'
    | 'bad-state'
    | 'all-terminal'
    | 'lost-superseded-lane'
    | 'unknown-default'
    | 'missing-client-status'
    | 'unexpected-client-status';
  readonly message: string;
}

export type LaneValidation =
  | { readonly ok: true; readonly lanes: readonly BlipStatusDef[]; readonly defaultStatus: string }
  | { readonly ok: false; readonly problems: readonly LaneProblem[] };

/**
 * Whether a template has a lane axis to override at all.
 *
 * A stream, a microblog — anything declaring no statuses — is not a board
 * missing its columns; it is a shape whose whole argument is that it has no
 * second axis. Giving one lanes would put a lane rail above a surface that has
 * never had one and a lane menu on every card, which is a layout change wearing
 * a vocabulary change's clothes.
 */
export function acceptsCustomLanes(templateId: string | null | undefined): boolean {
  return statusesFor(templateId).length > 0 && templateFor(templateId).customLanes !== false;
}

/** The templates a custom lane set may be written against. Registry-derived. */
export const LANE_CUSTOMISABLE_TEMPLATE_IDS: readonly RadarTemplate[] =
  RADAR_TEMPLATE_IDS.filter(acceptsCustomLanes);

/**
 * Check a proposed lane set against the template it will sit on.
 *
 * Returns **every** problem rather than the first, because the caller is
 * typically an agent composing a whole vocabulary in one go: telling it about
 * one bad id at a time turns a single fix into six round trips.
 *
 * This is a check of the *proposal alone*. Whether the radar has blips filed in
 * lanes the proposal drops is a question about stored rows, and it is answered
 * on the server — see `services/radars.ts`. Both refusals have to hold, and they
 * are separate because only one of them can be evaluated without a database.
 */
/**
 * A lane as a request carries it: what `laneSchema` parses to, where an absent
 * `terminal` may arrive as `undefined`. `validateLanes` hands back
 * `BlipStatusDef`s, with the key present only when it was given.
 */
export interface LaneInput {
  readonly id: string;
  /** Stored lanes are jsonb; one written by another build may lack a label. */
  readonly label: string | null | undefined;
  readonly state: BlipState;
  readonly terminal?: boolean | undefined;
  /** Required on a client-facing template, refused on every other. */
  readonly clientStatus?: string | undefined;
}

export function validateLanes(
  templateId: string | null | undefined,
  input: readonly LaneInput[],
  defaultStatus?: string | null,
): LaneValidation {
  const lanes: BlipStatusDef[] = input.map(({ id, label, state, terminal, clientStatus }) => ({
    id,
    label: label ?? '',
    state,
    ...(terminal === undefined ? {} : { terminal }),
    ...(isClientStatus(clientStatus) ? { clientStatus } : {}),
  }));
  const problems: LaneProblem[] = [];
  const add = (code: LaneProblem['code'], message: string) => problems.push({ code, message });

  if (!acceptsCustomLanes(templateId)) {
    const label = templateFor(templateId).label;
    add(
      'no-lane-axis',
      `A ${label} radar has no lanes to replace. Move it to a template that has ` +
        `them first — ${laneCustomisableLabels()} — or leave its lanes alone.`,
    );
    // Everything below is measured against a lane axis that is not there.
    return { ok: false, problems };
  }

  if (lanes.length < LANE_LIMITS.min) {
    add('too-few', `A lane set needs at least ${LANE_LIMITS.min} lanes; this has ${lanes.length}.`);
  }
  if (lanes.length > LANE_LIMITS.max) {
    add(
      'too-many',
      `A lane set may have at most ${LANE_LIMITS.max} lanes; this has ${lanes.length}. ` +
        `Past that a board scrolls sideways on a desktop and becomes a ${lanes.length}-tap ` +
        `pager on a phone.`,
    );
  }

  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!LANE_ID_PATTERN.test(lane.id) || lane.id.length > LANE_LIMITS.idMaxLength) {
      add(
        'bad-id',
        `"${lane.id}" is not a usable lane id. Lowercase letters, digits and hyphens, ` +
          `starting with a letter or digit, up to ${LANE_LIMITS.idMaxLength} characters.`,
      );
    } else if (seen.has(lane.id)) {
      add('duplicate-id', `Two lanes are both called "${lane.id}".`);
    }
    seen.add(lane.id);

    const label = lane.label.trim();
    if (!label || label.length > LANE_LIMITS.labelMaxLength) {
      add(
        'bad-label',
        `Lane "${lane.id}" needs a label of 1 to ${LANE_LIMITS.labelMaxLength} characters.`,
      );
    }
    if (!(BLIP_STATES as readonly string[]).includes(lane.state)) {
      add(
        'bad-state',
        `Lane "${lane.id}" declares state "${lane.state}", which is not a triage state. ` +
          `Every lane says what a blip becomes when it lands there, so a board and the ` +
          `Inbox count cannot disagree. One of: ${BLIP_STATES.join(', ')}.`,
      );
    }
  }

  // A lane set that is terminal end to end is a radar where everything captured
  // arrives already finished — and, on an archiving template, one where every
  // blip ages out of sight a month after it is written.
  if (lanes.length > 0 && lanes.every((lane) => lane.terminal)) {
    add('all-terminal', 'At least one lane must not be terminal, or nothing can be worked on.');
  }

  // Supersession files the replaced blip into a lane the template names. Drop
  // that lane and the verb keeps recording links while silently no longer
  // filing anything — the one failure here that is invisible on screen.
  const superseded = templateFor(templateId).supersededStatus;
  if (superseded && !seen.has(superseded)) {
    add(
      'lost-superseded-lane',
      `This template files a replaced entry into "${superseded}", so the lane set has to keep ` +
        `a lane with that id. Rename its label freely — the id is what supersession looks for.`,
    );
  }

  // A client-facing template shows its client one fixed status per lane, never
  // the lane's label (`helpdesk.ts`). A lane with no mapping would leave a
  // request in it with nothing safe to say, so every lane must name one — and
  // no other template may carry the field, so it cannot mean something there.
  const clientFacing = isClientFacingTemplate(templateId);
  for (const lane of input) {
    const given = lane.clientStatus;
    if (clientFacing && !isClientStatus(given)) {
      add(
        given === undefined ? 'missing-client-status' : 'unexpected-client-status',
        given === undefined
          ? `Lane "${lane.id}" needs a clientStatus — what a client is shown while a request ` +
              `sits there. One of: ${CLIENT_STATUSES.join(', ')}. The lane's label is never shown ` +
              `to a client.`
          : `Lane "${lane.id}" names clientStatus "${given}", which is not one of: ` +
              `${CLIENT_STATUSES.join(', ')}.`,
      );
    } else if (!clientFacing && given !== undefined) {
      add(
        'unexpected-client-status',
        `Lane "${lane.id}" names a clientStatus, but a ${templateFor(templateId).label} radar ` +
          `has no client side. Only ${clientFacingLabels()} lanes take one.`,
      );
    }
  }

  if (defaultStatus && !seen.has(defaultStatus)) {
    add('unknown-default', `defaultStatus "${defaultStatus}" is not one of the lanes.`);
  }

  if (problems.length > 0) return { ok: false, problems };
  // Safe: `lanes.length >= min` is asserted above, so index 0 exists.
  return { ok: true, lanes, defaultStatus: defaultStatus ?? (lanes[0] as BlipStatusDef).id };
}

/** "Kanban, Reading list, Decision log or Discussion" — for a refusal sentence. */
export function laneCustomisableLabels(): string {
  const labels = LANE_CUSTOMISABLE_TEMPLATE_IDS.map((id) => templateFor(id).label);
  return listWithOr(labels);
}

/**
 * The whole rulebook, derived from the registry, in the shape a tool hands to an
 * agent.
 *
 * Generated rather than written out, for the reason every other list in this
 * codebase is: a document that restates the registry is a document that is wrong
 * one commit after somebody adds a template. What an agent reads here is what
 * the validator will actually apply.
 */
export function laneGuide(): {
  limits: typeof LANE_LIMITS;
  idPattern: string;
  states: readonly BlipState[];
  rules: readonly string[];
  templates: ReadonlyArray<{
    id: string;
    label: string;
    layout: string;
    order: string;
    acceptsCustomLanes: boolean;
    archives: boolean;
    requiresLaneId: string | null;
    lanes: ReadonlyArray<{ id: string; label: string; state: BlipState; terminal: boolean }>;
  }>;
} {
  return {
    limits: LANE_LIMITS,
    idPattern: LANE_ID_PATTERN.source,
    states: BLIP_STATES,
    rules: [
      'A lane set replaces the words on a template, never its behaviour. Layout, ' +
        'ordering, capture rules, card facets and archiving stay with the template.',
      'Only a template that already has lanes may be given different ones: ' +
        `${laneCustomisableLabels()}.`,
      'Lane order is the running order of the page on a queue or a chronicle ' +
        'template. Declare them in the order somebody should meet them.',
      'Every lane declares the triage state a blip takes when it lands there. ' +
        'That is what keeps a board and the universal Inbox count in agreement.',
      'Mark a lane terminal when work that reaches it is over. Terminal lanes are ' +
        'drawn quieter, sort last, and on an archiving template are where finished ' +
        'blips age out of sight.',
      'A radar refuses a lane set that would strand blips it already holds. Move ' +
        'those blips first, or keep the lane id and change only its label.',
      'Changing a label is free and keeps every blip where it is. Changing an id ' +
        'is a different lane.',
    ],
    templates: RADAR_TEMPLATE_IDS.map((id) => {
      const def = templateFor(id);
      return {
        id: def.id,
        label: def.label,
        layout: def.layout,
        order: def.order,
        acceptsCustomLanes: acceptsCustomLanes(id),
        archives: def.archives === true,
        requiresLaneId: def.supersededStatus ?? null,
        lanes: def.statuses.map((lane) => ({
          id: lane.id,
          label: lane.label,
          state: lane.state,
          terminal: lane.terminal === true,
        })),
      };
    }),
  };
}

/** "Helpdesk" — for a refusal sentence. Registry-derived. */
export function clientFacingLabels(): string {
  return listWithOr(CLIENT_FACING_TEMPLATE_IDS.map((id) => RADAR_TEMPLATES[id].label));
}
