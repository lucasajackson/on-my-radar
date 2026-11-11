/**
 * Custom lanes: what a radar may be given, and what it is refused.
 *
 * Two halves, and they are separate because they fail differently. The
 * validator's job is to refuse an incoherent vocabulary *before* it is stored —
 * every assertion in the first half is a specific broken radar that would
 * otherwise exist. The resolver's job is to make a stored vocabulary read
 * exactly like a registry one everywhere downstream, so that the board, the
 * cursor, the card menu and the MCP output need no knowledge that an override
 * is possible.
 *
 * The stranded-blip refusal is not here: it needs rows, so it lives with the
 * database-backed tests.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptsCustomLanes,
  findStatus,
  LANE_CUSTOMISABLE_TEMPLATE_IDS,
  LANE_LIMITS,
  laneForState,
  laneGuide,
  laneRank,
  RADAR_TEMPLATE_IDS,
  resolveStatus,
  statusesFor,
  templateFor,
  validateLanes,
  type BlipStatusDef,
} from '@onmyradar/contract';

/** A pipeline: the example the whole feature exists for. Kanban, different words. */
const PIPELINE: BlipStatusDef[] = [
  { id: 'lead', label: 'Lead', state: 'inbox' },
  { id: 'contacted', label: 'Contacted', state: 'active' },
  { id: 'proposal', label: 'Proposal', state: 'active' },
  { id: 'won', label: 'Won', state: 'done', terminal: true },
  { id: 'lost', label: 'Lost', state: 'dropped', terminal: true },
];

const problemCodes = (result: ReturnType<typeof validateLanes>) =>
  result.ok ? [] : result.problems.map((problem) => problem.code);

describe('what a lane set must satisfy', () => {
  it('accepts the case the feature was asked for', () => {
    const result = validateLanes('kanban', PIPELINE);
    expect(result.ok).toBe(true);
    // Unstated default is the first lane, which is what all five shipped
    // templates already declare — so the common case needs no second field.
    if (result.ok) expect(result.defaultStatus).toBe('lead');
  });

  it('refuses a template with no lane axis to replace', () => {
    for (const id of RADAR_TEMPLATE_IDS.filter((t) => !acceptsCustomLanes(t))) {
      expect(problemCodes(validateLanes(id, PIPELINE))).toContain('no-lane-axis');
    }
    // And the refusal is the *only* thing said, rather than a pile of
    // consequences measured against an axis that is not there.
    expect(problemCodes(validateLanes('stream', PIPELINE))).toHaveLength(1);
  });

  it('names every template that can take one, from the registry', () => {
    expect(LANE_CUSTOMISABLE_TEMPLATE_IDS.length).toBeGreaterThan(0);
    for (const id of LANE_CUSTOMISABLE_TEMPLATE_IDS) {
      expect(statusesFor(id).length).toBeGreaterThan(0);
    }
  });

  it('holds the bounds', () => {
    expect(problemCodes(validateLanes('kanban', PIPELINE.slice(0, 1)))).toContain('too-few');
    const many = Array.from({ length: LANE_LIMITS.max + 1 }, (_, i) => ({
      id: `lane-${i}`,
      label: `Lane ${i}`,
      state: 'active' as const,
    }));
    expect(problemCodes(validateLanes('kanban', many))).toContain('too-many');
  });

  it('refuses an id that is not a usable id', () => {
    const bad = [
      { id: 'In Progress', label: 'In progress', state: 'active' as const },
      { id: 'ok', label: 'Fine', state: 'done' as const },
    ];
    expect(problemCodes(validateLanes('kanban', bad))).toContain('bad-id');
  });

  it('refuses two lanes with the same id', () => {
    const dupes = [
      { id: 'open', label: 'Open', state: 'inbox' as const },
      { id: 'open', label: 'Also open', state: 'active' as const },
    ];
    expect(problemCodes(validateLanes('kanban', dupes))).toContain('duplicate-id');
  });

  it('refuses a lane with no label', () => {
    const blank = [
      { id: 'a', label: '   ', state: 'inbox' as const },
      { id: 'b', label: 'B', state: 'done' as const },
    ];
    expect(problemCodes(validateLanes('kanban', blank))).toContain('bad-label');
  });

  /**
   * The invariant that keeps a board and the universal Inbox count in agreement.
   * A lane with a made-up state is the one bad value that would show up as two
   * screens disagreeing rather than as anything visibly broken.
   */
  it('refuses a lane whose state is not a triage state', () => {
    const bogus = [
      { id: 'a', label: 'A', state: 'in-progress' as unknown as BlipStatusDef['state'] },
      { id: 'b', label: 'B', state: 'done' as const },
    ];
    expect(problemCodes(validateLanes('kanban', bogus))).toContain('bad-state');
  });

  it('refuses a board where every lane is terminal', () => {
    const finished = [
      { id: 'won', label: 'Won', state: 'done' as const, terminal: true },
      { id: 'lost', label: 'Lost', state: 'dropped' as const, terminal: true },
    ];
    expect(problemCodes(validateLanes('kanban', finished))).toContain('all-terminal');
  });

  /**
   * The invisible one. Supersession files the replaced entry into a lane the
   * template names by id; drop that lane and the verb keeps recording links
   * while silently filing nothing, which nothing on the page would show.
   */
  it('refuses dropping the lane supersession files into', () => {
    const decisions = templateFor('decisions');
    expect(decisions.supersededStatus).toBeTruthy();
    const withoutIt = decisions.statuses
      .filter((lane) => lane.id !== decisions.supersededStatus)
      .map((lane) => ({ ...lane }));
    expect(problemCodes(validateLanes('decisions', withoutIt))).toContain('lost-superseded-lane');

    // Relabelling it is fine — the id is what supersession looks for.
    const relabelled = decisions.statuses.map((lane) =>
      lane.id === decisions.supersededStatus ? { ...lane, label: 'Overtaken' } : { ...lane },
    );
    expect(validateLanes('decisions', relabelled).ok).toBe(true);
  });

  it('refuses a default that is not one of the lanes', () => {
    expect(problemCodes(validateLanes('kanban', PIPELINE, 'nowhere'))).toContain('unknown-default');
    const result = validateLanes('kanban', PIPELINE, 'proposal');
    expect(result.ok && result.defaultStatus).toBe('proposal');
  });

  /**
   * Reported together rather than one at a time: the caller is usually an agent
   * composing a whole vocabulary, and one problem per round trip turns a single
   * fix into six calls.
   */
  it('reports every problem at once', () => {
    const messy = [{ id: 'Bad Id', label: '', state: 'nope' as unknown as BlipStatusDef['state'] }];
    const codes = problemCodes(validateLanes('kanban', messy));
    expect(codes).toEqual(expect.arrayContaining(['too-few', 'bad-id', 'bad-label', 'bad-state']));
  });
});

describe('a radar reads in its own lanes', () => {
  const config = { lanes: PIPELINE };

  it('substitutes the vocabulary and leaves the behaviour alone', () => {
    const custom = templateFor('kanban', config);
    const base = templateFor('kanban');
    expect(custom.statuses.map((lane) => lane.id)).toEqual([
      'lead',
      'contacted',
      'proposal',
      'won',
      'lost',
    ]);
    // Everything that needs code stays the template's.
    expect(custom.layout).toBe(base.layout);
    expect(custom.order).toBe(base.order);
    expect(custom.facets).toEqual(base.facets);
    expect(custom.archives).toBe(base.archives);
    expect(custom.capture).toEqual(base.capture);
  });

  it('lands new blips in the first lane, or the one named', () => {
    expect(templateFor('kanban', config).defaultStatus).toBe('lead');
    expect(templateFor('kanban', { ...config, defaultStatus: 'proposal' }).defaultStatus).toBe(
      'proposal',
    );
    // A stored default that is not one of the lanes falls back rather than
    // producing a radar whose capture target does not exist.
    expect(templateFor('kanban', { ...config, defaultStatus: 'gone' }).defaultStatus).toBe('lead');
  });

  it('ranks, resolves and repairs against the custom lanes', () => {
    expect(laneRank('kanban', 'proposal', config)).toBe(2);
    // A lane the *registry* declares is not one this radar has any more.
    expect(findStatus('kanban', 'backlog', config)).toBeNull();
    expect(resolveStatus('kanban', undefined, null, config)).toBe('lead');
    expect(resolveStatus('kanban', 'won', null, config)).toBe('won');
    expect(resolveStatus('kanban', 'backlog', null, config)).toBeNull();
    expect(laneForState('kanban', 'dropped', config)?.id).toBe('lost');
  });

  /**
   * The degradation that keeps a radar readable. Moving to a template with no
   * lane axis leaves the stored vocabulary in place — nothing is deleted — and
   * it simply stops being applied, which is the same rule an unknown template id
   * already follows.
   */
  it('ignores a stored lane set on a template that has no lanes', () => {
    expect(statusesFor('stream', config)).toHaveLength(0);
    expect(templateFor('stream', config).defaultStatus).toBeNull();
  });

  it('reads the template s own lanes when nothing is overridden', () => {
    expect(statusesFor('kanban', {})).toEqual(statusesFor('kanban'));
    expect(statusesFor('kanban', { lanes: [] })).toEqual(statusesFor('kanban'));
  });
});

describe('the guide an agent is handed', () => {
  const guide = laneGuide();

  /** Generated from the registry, so it cannot drift from what the validator applies. */
  it('describes every template that exists', () => {
    expect(guide.templates.map((t) => t.id).sort()).toEqual([...RADAR_TEMPLATE_IDS].sort());
  });

  it('says which templates take custom lanes, and agrees with the validator', () => {
    for (const entry of guide.templates) {
      expect(entry.acceptsCustomLanes).toBe(acceptsCustomLanes(entry.id));
      const refused = problemCodes(validateLanes(entry.id, PIPELINE)).includes('no-lane-axis');
      expect(refused).toBe(!entry.acceptsCustomLanes);
    }
  });

  it('publishes the lane id supersession needs kept', () => {
    const decisions = guide.templates.find((t) => t.id === 'decisions');
    expect(decisions?.requiresLaneId).toBe(templateFor('decisions').supersededStatus);
  });

  it('publishes the same limits the validator enforces', () => {
    expect(guide.limits).toEqual(LANE_LIMITS);
  });
});

describe('a template whose lanes are its meaning', () => {
  it('takes no custom lane set: refused on write, ignored on read', () => {
    expect(acceptsCustomLanes('architecture')).toBe(false);
    expect(problemCodes(validateLanes('architecture', PIPELINE))).toEqual(['no-lane-axis']);
    // A set stored before the radar moved here must not replace the ratification lanes.
    const config = { lanes: PIPELINE, defaultStatus: 'lead' };
    expect(statusesFor('architecture', config).map((l) => l.id)).toEqual(
      statusesFor('architecture').map((l) => l.id),
    );
    expect(templateFor('architecture', config).defaultStatus).toBe('proposed');
    expect(LANE_CUSTOMISABLE_TEMPLATE_IDS).not.toContain('architecture');
  });
});
