/**
 * Radar templates — the two-axis rule.
 *
 * `state` is universal triage and never changes shape. `status` is the lane of
 * whichever template the radar is on. These tests pin the thing that makes the
 * pair coherent: landing in a lane carries the blip's triage state with it, so a
 * board's Done column and the Inbox count can never disagree.
 */
import { describe, expect, it } from 'vitest';
import {
  commentsAllowed,
  conversationFor,
  isClientFacingTemplate,
  DEFAULT_RADAR_TEMPLATE,
  findStatus,
  hasGrouping,
  isRadarTemplate,
  laneMoveAllowed,
  laneRank,
  orderFor,
  photosFor,
  readStateFor,
  RADAR_TEMPLATES,
  RADAR_TEMPLATE_IDS,
  resolveStatus,
  statusesFor,
  supersededLane,
  templateFor,
  BLIP_STATES,
} from '@onmyradar/contract';

describe('the registry', () => {
  it('declares every template with a usable default lane', () => {
    for (const id of RADAR_TEMPLATE_IDS) {
      const template = RADAR_TEMPLATES[id];
      if (template.statuses.length === 0) {
        expect(template.defaultStatus).toBeNull();
      } else {
        expect(findStatus(id, template.defaultStatus)).not.toBeNull();
      }
    }
  });

  it('maps every lane to a real triage state', () => {
    // A lane implying a state that does not exist would silently break the
    // CHECK constraint on blips.state at write time, not at review time.
    for (const id of RADAR_TEMPLATE_IDS) {
      for (const lane of statusesFor(id)) {
        expect(BLIP_STATES).toContain(lane.state);
      }
    }
  });

  it('gives every template a distinct set of lane ids', () => {
    for (const id of RADAR_TEMPLATE_IDS) {
      const ids = statusesFor(id).map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

/**
 * The axes that stop a template being the stream with different words in a
 * dropdown. Reading list, decision log and stream shipped differing only by
 * their lanes and a placeholder, which is why they read as the same thing —
 * these are the declarations that make them behave differently, and these are
 * the rules that keep those declarations coherent.
 */
describe('the axes a template is differentiated by', () => {
  it('only lets a template sort by lane if it has lanes', () => {
    // `queue` and `chronicle` both sort on lane rank first. A template declaring
    // one with no lanes would sort every row into a single bucket and silently
    // read as capture order — a distinction that exists in the registry and
    // nowhere else is exactly the failure this whole change is about.
    for (const id of RADAR_TEMPLATE_IDS) {
      if (orderFor(id) !== 'captured') {
        expect(statusesFor(id).length).toBeGreaterThan(0);
      }
    }
  });

  it('only offers a lane filter to a template that has lanes to filter by', () => {
    for (const id of RADAR_TEMPLATE_IDS) {
      if (RADAR_TEMPLATES[id].laneFilter) {
        expect(statusesFor(id).length).toBeGreaterThan(0);
      }
    }
  });

  it('never puts the lane rail on a board, which already draws its lanes', () => {
    // Two controls for one axis is the "says it twice" failure the title rule
    // exists to avoid, one layer out.
    for (const id of RADAR_TEMPLATE_IDS) {
      if (RADAR_TEMPLATES[id].layout === 'board') {
        expect(RADAR_TEMPLATES[id].laneFilter).toBe(false);
      }
    }
  });

  it('only declares the moved facet on a template that has lanes, and not where a ratifier is shown', () => {
    const declared = Object.values(RADAR_TEMPLATES).filter((t) =>
      (t.facets as readonly string[]).includes('moved'),
    );
    expect(declared.map((t) => t.id).sort()).toEqual(['helpdesk', 'kanban', 'reading']);
    for (const t of declared) expect(t.statuses.length, t.id).toBeGreaterThan(0);
    // A decision log and the architecture radar already show who ratified.
    for (const id of ['decisions', 'architecture'] as const)
      expect((RADAR_TEMPLATES[id].facets as readonly string[]).includes('moved')).toBe(false);
  });

  it('resolves a declared superseded lane to a real lane', () => {
    for (const id of RADAR_TEMPLATE_IDS) {
      // Through `templateFor`, which is typed `RadarTemplateDef`. Indexing
      // `RADAR_TEMPLATES` directly gives the union of the five literal object
      // types, and `supersededStatus` is optional — so it is absent from the
      // literal type of every template that does not declare one. The interface
      // *is* enforced, by the `as const satisfies Record<string,
      // RadarTemplateDef>` on the registry; this is reading it back through the
      // same door.
      const declared = templateFor(id).supersededStatus;
      if (declared) {
        expect(supersededLane(id)?.id).toBe(declared);
        // The lane a replaced entry lands in has to be terminal, or a
        // superseded decision would sit among the live ones.
        expect(supersededLane(id)?.terminal).toBe(true);
      } else {
        expect(supersededLane(id)).toBeNull();
      }
    }
  });

  it('keeps the stream the null template', () => {
    // Its whole job is to be the baseline. A stream that infers or re-sorts is
    // a template, and templates are meant to be the thing you opt into.
    const stream = RADAR_TEMPLATES.stream;
    expect(stream.order).toBe('captured');
    expect(stream.statuses).toHaveLength(0);
    expect(stream.facets).toHaveLength(0);
    expect(stream.capture).toEqual({});
    expect(stream.laneFilter).toBe(false);
  });

  it('ranks lanes in declared order, with anything unlaned last', () => {
    // Declaration order is load-bearing for `queue` and `chronicle`: reorder the
    // lanes and you reorder the page.
    expect(laneRank('reading', 'unread')).toBe(0);
    expect(laneRank('reading', 'finished')).toBe(2);
    expect(laneRank('reading', 'abandoned')).toBe(3);
    expect(laneRank('reading', null)).toBe(4);
    // A stored lane this template does not know sorts with the unlaned rather
    // than throwing — the same degradation as `templateFor`.
    expect(laneRank('reading', 'doing')).toBe(4);
    expect(laneRank('stream', null)).toBe(0);
  });

  it('only lets a template declare threading where the conversation is the content', () => {
    // A folded thread cannot show nesting: the reply-to control lives inside the
    // expanded thread, so `threaded` without `expanded` declares an affordance
    // that has nowhere to appear. Cheap to state, and it is the exact shape of
    // the "declared and invisible" failure that made three templates feel alike.
    for (const id of RADAR_TEMPLATE_IDS) {
      const conversation = conversationFor(id);
      if (conversation.threaded) expect(conversation.expanded).toBe(true);
    }
  });

  it('leaves every template but the discussion with a folded, flat thread', () => {
    // The restraint is the default and has to stay the default: a permanent
    // conversation surface under every private note is rent charged on the
    // surface whose whole thesis is that capture is cheap.
    for (const id of RADAR_TEMPLATE_IDS) {
      const conversation = conversationFor(id);
      if (id === 'discussion') {
        expect(conversation).toEqual({
          expanded: true,
          threaded: true,
          replyNoun: 'reply',
          replyNounPlural: 'replies',
          visibility: false,
        });
      } else {
        expect(conversation.expanded).toBe(false);
        expect(conversation.threaded).toBe(false);
        expect(conversation.replyNoun).toBe('comment');
      }
    }
  });

  it('offers a client side in the conversation exactly where the template faces a client', () => {
    // One flag, not two: the composer's "Reply to client" and the server's
    // acceptance of `visibility: 'client'` both read `clientFacing`, which is
    // also what makes a radar never public (docs/HELPDESK.md §7.2).
    for (const id of RADAR_TEMPLATE_IDS) {
      expect(conversationFor(id).visibility).toBe(isClientFacingTemplate(id));
    }
    expect(conversationFor('helpdesk').visibility).toBe(true);
    expect(conversationFor('kanban').visibility).toBe(false);
    expect(conversationFor('no-such-template').visibility).toBe(false);
  });

  it('gives the decision log a chronicle, and the reading list the newest-first reader', () => {
    // Named explicitly rather than derived, because these values are the
    // whole answer to "how is this not just the stream".
    expect(orderFor('reading')).toBe('captured');
    expect(orderFor('decisions')).toBe('chronicle');
    expect(orderFor('stream')).toBe('captured');
    expect(orderFor('kanban')).toBe('captured');
    expect(orderFor('microblog')).toBe('captured');
  });

  it('declares the reader per template: no comments, and read state over real lanes', () => {
    expect(commentsAllowed('reading')).toBe(false);
    for (const id of ['stream', 'kanban', 'microblog', 'discussion']) {
      expect(commentsAllowed(id), id).toBe(true);
    }
    expect(RADAR_TEMPLATES.reading.layout).toBe('reader');
    expect(readStateFor('reading')).toEqual({ unread: 'unread', read: 'reading' });
    expect(readStateFor('stream')).toBeNull();
    // Custom lanes that drop either end leave no read state, rather than a broken one.
    expect(
      readStateFor('reading', { lanes: [{ id: 'later', label: 'Later', state: 'later' }] }),
    ).toBeNull();
    // The read lane is a live one: opening a story must not start the archive clock.
    const { readState } = RADAR_TEMPLATES.reading;
    expect(findStatus('reading', readState.unread)).not.toBeNull();
    expect(findStatus('reading', readState.read)?.terminal).not.toBe(true);
  });

  it('features a picture only where the picture is the post', () => {
    // The axis exists because one flag used to mean two things: `compact` told
    // a card to drop its kind badge AND told the attachment block that a picture
    // here was a thumbnail. The microblog wanted the first and silently got the
    // second, which is how a published photo ended up as an 11rem thumbnail
    // hanging off the left margin. `feature` centres it and gives it the column.
    expect(photosFor('microblog')).toBe('feature');
    // A card inside a lane is an index entry; the picture marks it. That is a
    // fact about the board layout, so every board template says it — the
    // helpdesk included.
    expect(photosFor('kanban')).toBe('thumb');
    expect(photosFor('helpdesk')).toBe('thumb');
    // Everything else attaches a picture to a thought, and leaves it inline.
    for (const id of RADAR_TEMPLATE_IDS) {
      if (id === 'microblog' || RADAR_TEMPLATES[id].layout === 'board') continue;
      expect(photosFor(id)).toBe('inline');
    }
  });

  it('reads an inline picture for a template it has never heard of', () => {
    expect(photosFor('sudoku')).toBe('inline');
    expect(photosFor(null)).toBe('inline');
  });

  it('offers the day rule only where a diary reading of the surface exists', () => {
    // Registry-driven so the settings dialog can stop asking
    // `template === 'microblog'`, which is the special-casing bb602ab removed
    // everywhere else.
    expect(hasGrouping('microblog')).toBe(true);
    for (const id of RADAR_TEMPLATE_IDS) {
      if (id === 'microblog') continue;
      expect(hasGrouping(id)).toBe(false);
    }
    expect(hasGrouping('sudoku')).toBe(false);
  });

  it('reads capture order for a template it has never heard of', () => {
    expect(orderFor('gantt-chart-from-2027')).toBe('captured');
  });
});

describe('templateFor', () => {
  it('degrades an unknown template to the stream rather than throwing', () => {
    // A radar created by a future build has to still open in this one.
    expect(templateFor('gantt-chart-from-2027').id).toBe(DEFAULT_RADAR_TEMPLATE);
    expect(templateFor(null).id).toBe(DEFAULT_RADAR_TEMPLATE);
    expect(templateFor(undefined).id).toBe(DEFAULT_RADAR_TEMPLATE);
    expect(isRadarTemplate('gantt-chart-from-2027')).toBe(false);
  });
});

describe('resolveStatus', () => {
  it('puts a new blip in the template default lane', () => {
    expect(resolveStatus('kanban', undefined, null)).toBe('backlog');
    expect(resolveStatus('reading', undefined, null)).toBe('unread');
  });

  it('has no lane at all on a template without one', () => {
    expect(resolveStatus('stream', undefined, null)).toBeNull();
    expect(resolveStatus('microblog', 'doing', null)).toBeNull();
  });

  it('honours an explicit lane the template knows', () => {
    expect(resolveStatus('kanban', 'doing', 'backlog')).toBe('doing');
  });

  it('drops a lane the template does not know instead of storing it', () => {
    // Otherwise a typo'd status would sit in the row and match no column.
    expect(resolveStatus('kanban', 'in-flight', 'backlog')).toBeNull();
  });

  it('keeps a lane that still exists when nothing was asked for', () => {
    expect(resolveStatus('kanban', undefined, 'doing')).toBe('doing');
  });

  it('re-homes a blip whose stored lane means nothing on the new template', () => {
    // Moving a card from a board to a reading list: 'doing' is not a stage
    // there, so it lands in the reading list's own default rather than nowhere.
    expect(resolveStatus('reading', undefined, 'doing')).toBe('unread');
  });
});

describe('lane to state', () => {
  it('carries a terminal lane into a terminal triage state', () => {
    expect(findStatus('kanban', 'done')?.state).toBe('done');
    expect(findStatus('reading', 'abandoned')?.state).toBe('dropped');
    expect(findStatus('decisions', 'rejected')?.state).toBe('dropped');
  });

  it('keeps an opening lane in the inbox', () => {
    expect(findStatus('kanban', 'backlog')?.state).toBe('inbox');
    expect(findStatus('decisions', 'proposed')?.state).toBe('inbox');
  });
});

describe('lane moves and ratification', () => {
  it('declares only lanes the template has', () => {
    for (const id of RADAR_TEMPLATE_IDS) {
      const template = templateFor(id);
      const lanes = new Set(template.statuses.map((l) => l.id));
      for (const [from, targets] of Object.entries(template.transitions ?? {})) {
        expect(lanes.has(from), `${id}: ${from}`).toBe(true);
        for (const to of targets) expect(lanes.has(to), `${id}: ${to}`).toBe(true);
      }
      for (const lane of [template.ratifiedStatus, template.supersededStatus])
        if (lane) expect(lanes.has(lane), `${id}: ${lane}`).toBe(true);
    }
  });

  it('lets the architecture lanes move only along the declared edges', () => {
    const allowed = (from: string, to: string) => laneMoveAllowed('architecture', from, to);
    expect(allowed('proposed', 'accepted') && allowed('proposed', 'rejected')).toBe(true);
    expect(allowed('accepted', 'repealed')).toBe(true);
    expect(allowed('accepted', 'accepted')).toBe(true);
    for (const [from, to] of [
      ['rejected', 'accepted'],
      ['proposed', 'repealed'],
      ['repealed', 'accepted'],
      ['charter', 'proposed'],
      ['proposed', 'charter'],
    ] as const)
      expect(allowed(from, to), `${from} to ${to}`).toBe(false);
    // Every other template moves freely.
    expect(laneMoveAllowed('kanban', 'done', 'todo')).toBe(true);
  });
});
