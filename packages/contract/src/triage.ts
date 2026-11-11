/**
 * What "move it along" and "put it off" mean on a given template.
 *
 * This is the first module of the shared UI contract (`docs/UI-CONTRACT.md`).
 * It exists because the rule had already been written twice: once in the SPA's
 * card menus and once, in Swift, in the iOS client's `TriageResolver`. Two
 * copies of a rule that reads a registry is exactly how a fourth client drifts,
 * and the drift is silent — both copies keep working, they just stop agreeing
 * about what Done means on a reading list.
 *
 * ## Why this is contract and not presentation
 *
 * A gesture is a platform's business: a swipe on iOS, a hover menu on the web,
 * a keyboard shortcut on a desktop client. What is *not* the platform's
 * business is which lane a blip lands in when somebody advances it, because
 * that is a fact about the template, and templates are declarations here
 * (DESIGN §4). The client asks "what does advancing mean here" and renders the
 * answer; it never decides.
 *
 * ## The two-way rule
 *
 * Advancing something already at the end of the line means bringing it back,
 * not doing nothing. A card in Done that offers a greyed-out "Done" is a dead
 * control; one that offers "Reopen" is the same gesture continuing to mean
 * something. Same for defer. This is why the functions return a *target* with
 * its own label rather than a boolean.
 *
 * ## The rules, unified with the web (2026-09-26)
 *
 * The SPA and this module disagreed in four places (UI-CONTRACT §11); the owner
 * chose to unify them here, taking whichever side was better for a person:
 *
 * 1. **A lane template moves between its lanes**, and says so in the lane's
 *    own word ("Finished", "Resolved") — never a bare state the server has to
 *    map to some lane.
 * 2. **Reopening goes back to work, not to the inbox.** Something reopened was
 *    already decided about; putting it in the inbox asks the person to triage
 *    it again. The target is the working state (`active`), or the first
 *    working lane — a lane whose state is `active`, else the first lane that
 *    is not terminal.
 * 3. **Deferring is a gradient.** Put it off once and it is Later; put off
 *    something already Later and it is Dropped. Defer on something settled
 *    (done, dropped, a terminal lane) reopens it — the two-way rule at the
 *    real end of the road.
 * 4. **No gesture where triage is invisible.** A template with no lanes and
 *    no triage (the timeline) gets no control at all — see
 *    `allowsTriageGesture`.
 */

import type { BlipState } from './domain.js';
import { templateFor, type BlipStatusDef, type TemplateConfig } from './templates.js';

/** Where a triage action puts a blip, and what to call the act of doing it. */
export interface TriageTarget {
  /** The template's own lane, when it has one. */
  readonly status?: string;
  /** The universal triage state, when the template has no lanes. */
  readonly state?: BlipState;
  /**
   * What the control says, and what the acknowledgement says afterwards.
   * Taken from the lane's own label where there is one, so a reading list
   * says "Finished" and a discussion says "Resolved" without either word
   * appearing in a client.
   */
  readonly label: string;
  /** True when this target undoes a previous advance/defer rather than doing one. */
  readonly reopens: boolean;
  /**
   * What to say once it is done, in the past tense — "Marked done", "Moved to
   * Finished", "Reopened". The label is the verb on the control; this is the
   * acknowledgement, and a client should not have to conjugate one into the
   * other.
   */
  readonly acknowledgement: string;
}

interface TriageSource {
  readonly template: string | null;
  readonly templateConfig?: TemplateConfig | null;
}

function lanes(source: TriageSource): readonly BlipStatusDef[] {
  return templateFor(source.template, source.templateConfig).statuses;
}

/** Done or dropped: decided, one way or the other. */
const settled = (state: string) => state === 'done' || state === 'dropped';

/** Back to work: the first working lane, or the working state. */
function reopen(laneSet: readonly BlipStatusDef[]): TriageTarget | null {
  if (laneSet.length === 0) {
    return { state: 'active', label: 'Reopen', acknowledgement: 'Reopened', reopens: true };
  }
  const working =
    laneSet.find((lane) => !lane.terminal && lane.state === 'active') ??
    laneSet.find((lane) => !lane.terminal);
  return working
    ? {
        status: working.id,
        label: `Back to ${working.label}`,
        acknowledgement: `Back in ${working.label}`,
        reopens: true,
      }
    : null;
}

function toLane(lane: BlipStatusDef): TriageTarget {
  return {
    status: lane.id,
    label: lane.label,
    acknowledgement: `Moved to ${lane.label}`,
    reopens: false,
  };
}

/**
 * The lane or state that "move it along" means here — Done, Finished,
 * Resolved, Accepted — or the way back when the blip is already settled.
 *
 * Returns null when the template has no notion of advancing, which is a real
 * answer rather than a missing one: a microblog post is published, not done,
 * and a client must render no control rather than an inert one.
 */
export function advanceTarget(
  source: TriageSource,
  blip: { state: string; status?: string | null | undefined },
): TriageTarget | null {
  const laneSet = lanes(source);

  if (laneSet.length > 0) {
    const current = laneSet.find((lane) => lane.id === blip.status);
    // Settled by its state as well as by `terminal`: a decision log's Accepted
    // is `done` without being terminal, and advancing it used to target itself.
    if (current && (current.terminal || settled(current.state))) return reopen(laneSet);
    const done = laneSet.find((lane) => lane.state === 'done');
    return done ? toLane(done) : null;
  }

  // No lanes: the universal axis. Only a template that shows triage at all
  // offers this, which `showTriage` already says.
  if (!templateFor(source.template).showTriage) return null;
  return settled(blip.state)
    ? reopen(laneSet)
    : { state: 'done', label: 'Done', acknowledgement: 'Marked done', reopens: false };
}

/**
 * The lane or state that "put it off" means here: Later, then Dropped for
 * something already Later — or the way back for something settled.
 */
export function deferTarget(
  source: TriageSource,
  blip: { state: string; status?: string | null | undefined },
): TriageTarget | null {
  const laneSet = lanes(source);

  if (laneSet.length > 0) {
    const current = laneSet.find((lane) => lane.id === blip.status);
    if (current && (current.terminal || settled(current.state))) return reopen(laneSet);
    const later = laneSet.find((lane) => lane.state === 'later' && lane.id !== current?.id);
    const dropped = laneSet.find((lane) => lane.state === 'dropped');
    const off = current?.state === 'later' ? dropped : (later ?? dropped);
    return off ? toLane(off) : null;
  }

  if (!templateFor(source.template).showTriage) return null;
  if (settled(blip.state)) return reopen(laneSet);
  return blip.state === 'later'
    ? { state: 'dropped', label: 'Drop', acknowledgement: 'Dropped', reopens: false }
    : { state: 'later', label: 'Later', acknowledgement: 'Filed under Later', reopens: false };
}

/**
 * Whether a gesture may triage on this template at all.
 *
 * Two refusals, both from DESIGN §16 and both about meaning rather than
 * ergonomics:
 *
 * - **A board** draws its lanes as columns and moving between them is already
 *   a drag; a second gesture on the same axis is two ways to do one thing.
 * - **A decision log** would be saying that a swipe accepts a decision, and a
 *   decision is the one thing in this application that should cost a
 *   deliberate act.
 *
 * Declared here rather than checked as `layout === 'board'` in three clients.
 */
export function allowsTriageGesture(source: TriageSource): boolean {
  const template = templateFor(source.template, source.templateConfig);
  if (
    template.layout === 'board' ||
    template.layout === 'log' ||
    template.layout === 'architecture'
  )
    return false;
  return template.showTriage || template.statuses.length > 0;
}
