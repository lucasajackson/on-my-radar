/**
 * The contract, as data a non-TypeScript client can check itself against.
 *
 * `on-my-radar-ios` mirrors these registries in Swift because Swift cannot
 * import this package. The mirror is hand-written, so the only thing standing
 * between it and silent drift is a test — and a test needs something to
 * compare against. This emits that something.
 *
 * Two halves, and the second is the one that matters:
 *
 * 1. **Registries.** Every declared value a client renders from: templates and
 *    all their properties, lanes, accents, glyphs, theme axes, limits. A
 *    mirror that has dropped a template or renamed a lane fails on this.
 * 2. **Behaviour vectors.** Input/output pairs for the pure functions a client
 *    re-implements — capture inference, tag and mention normalisation, title
 *    extraction, triage resolution, action availability. A mirror that agrees
 *    on the data and disagrees on the *rules* fails on this, and that is the
 *    failure that would otherwise reach a person as "the app said this would
 *    be a link and the server made it a note".
 *
 * Deterministic and sorted, so a refreshed snapshot with no real change
 * produces no diff. Run `pnpm --filter @onmyradar/contract snapshot`.
 */

import {
  ACCENT_FAMILIES,
  BLIP_KINDS,
  BLIP_REACTIONS,
  BLIP_STATES,
  BLIP_STATE_LABELS,
  ESSAY_BODY_THRESHOLD,
  GLYPH_GROUPS,
  LIMITS,
  NOTIFICATION_KINDS,
  RADAR_ACCENTS,
  RADAR_GLYPHS,
  RADAR_NOTIFY_LEVELS,
  SESSION_CLIENTS,
  API_V1,
  deriveBlipKind,
} from './domain.js';
import {
  RADAR_TEMPLATE_IDS,
  archivesFor,
  conversationFor,
  hasGrouping,
  isThemeable,
  photosFor,
  templateFor,
  type RadarTemplateDef,
} from './templates.js';
import { DEFAULT_RADAR_THEME, RADAR_SURFACES, THEME_AXES, THEME_PRESETS } from './theme.js';
import {
  extractInlineTags,
  firstUrl,
  headingTitle,
  mentionKey,
  normalizeTag,
  soleUrl,
  MENTION_PATTERN,
} from './text.js';
import { advanceTarget, allowsTriageGesture, deferTarget } from './triage.js';
import { BLIP_ACTIONS, actionAvailability, type ActionContext } from './actions.js';

/** The version of the snapshot's own shape, not of the contract. */
export const SNAPSHOT_FORMAT = 1;

function templateSnapshot() {
  return RADAR_TEMPLATE_IDS.map((id) => {
    // Read through `templateFor` and the registry's own helpers rather than
    // indexing the literal: `as const satisfies` narrows each entry to its own
    // shape, so an optional property is invisible on the templates that omit
    // it — and these are the very defaults a mirror has to agree about.
    const template: RadarTemplateDef = templateFor(id);
    const conversation = conversationFor(id);
    return {
      id,
      label: template.label,
      layout: template.layout,
      order: template.order,
      inbox: template.inbox,
      showTriage: template.showTriage,
      laneFilter: template.laneFilter,
      defaultStatus: template.defaultStatus,
      capturePlaceholder: template.capturePlaceholder,
      facets: [...template.facets],
      photos: photosFor(id),
      grouping: hasGrouping(id),
      themeable: isThemeable(id),
      archives: archivesFor(id),
      linkFirstCapture: template.capture.linkFirst === true,
      supersededStatus: template.supersededStatus ?? null,
      conversation: {
        expanded: conversation.expanded,
        threaded: conversation.threaded,
        replyNoun: conversation.replyNoun,
        replyNounPlural: conversation.replyNounPlural,
      },
      statuses: template.statuses.map((lane) => ({
        id: lane.id,
        label: lane.label,
        state: lane.state,
        terminal: lane.terminal === true,
      })),
    };
  });
}

/**
 * Triage vectors over every template and every lane it declares, plus the
 * unlaned case. This is the set that catches a mirror agreeing about lanes
 * while disagreeing about which one "advance" means.
 */
function triageVectors() {
  const vectors: unknown[] = [];
  for (const id of RADAR_TEMPLATE_IDS) {
    const template = templateFor(id);
    const positions =
      template.statuses.length > 0
        ? template.statuses.map((lane) => ({ status: lane.id, state: lane.state }))
        : BLIP_STATES.map((state) => ({ status: null, state }));
    for (const position of positions) {
      const blip = { state: position.state, status: position.status };
      vectors.push({
        template: id,
        status: position.status,
        state: position.state,
        gestureAllowed: allowsTriageGesture({ template: id }),
        advance: advanceTarget({ template: id }, blip),
        defer: deferTarget({ template: id }, blip),
      });
    }
  }
  return vectors;
}

/**
 * Availability vectors across the axes that actually change an answer:
 * template, write access, pinned, and the two per-radar switches.
 */
function availabilityVectors() {
  const vectors: unknown[] = [];
  for (const id of RADAR_TEMPLATE_IDS) {
    for (const canWrite of [true, false]) {
      for (const pinned of [true, false]) {
        for (const commentsEnabled of [true, false]) {
          const context: ActionContext = {
            radar: {
              template: id,
              commentsEnabled,
              reactionsEnabled: true,
              visibility: 'private',
              access: { canWrite, canManage: canWrite },
            },
            blip: { state: 'inbox', status: templateFor(id).defaultStatus, pinned },
          };
          vectors.push({
            template: id,
            canWrite,
            pinned,
            commentsEnabled,
            actions: BLIP_ACTIONS.map((action) => ({
              id: action.id,
              availability: actionAvailability(action.id, context),
            })),
          });
        }
      }
    }
  }
  return vectors;
}

function inferenceVectors() {
  const bodies = [
    '',
    'call the plumber',
    'https://example.com/x',
    '  https://example.com/x  ',
    'https://example.com/x #reading',
    '#reading https://example.com/x #later',
    'https://example.com/x#section',
    'read https://example.com/x',
    '# Ship it\nthe body',
    'ship the #thing and the #other #thing',
    'issue#42',
    '#café and #日本語',
    'https://example.com/x — because Ben said so',
    '[title](https://example.com/x)',
    'https://en.wikipedia.org/wiki/Mercury_(planet)',
    'ask @ada about it',
    'write to ada@example.com',
    'https://example.com/@ada',
    'x'.repeat(ESSAY_BODY_THRESHOLD),
    'x'.repeat(ESSAY_BODY_THRESHOLD + 1),
  ];
  return bodies.map((body) => ({
    body,
    // A body that is nothing but its URL (and tags) is the link, not text about
    // it — the rule `createBlip` applies, so the vectors say what the server does.
    kind: deriveBlipKind({ body: soleUrl(body) ? '' : body, url: soleUrl(body) }),
    tags: extractInlineTags(body),
    headingTitle: headingTitle(body),
    soleUrl: soleUrl(body),
    firstUrl: firstUrl(body),
  }));
}

function normalisationVectors() {
  const tags = [
    '#Side Projects',
    '  #Ada_Lovelace  ',
    '###multi',
    '--edges--',
    '#café',
    'a'.repeat(100),
  ];
  const handles = ['@Ada Lovelace', '@ada.lovelace', '@ada_lovelace', 'ada.', '@@ada'];
  return {
    tags: tags.map((input) => ({ input, output: normalizeTag(input) })),
    mentions: handles.map((input) => ({ input, output: mentionKey(input) })),
  };
}

/** The whole thing, deterministic and sorted. */
export function buildSnapshot() {
  return {
    format: SNAPSHOT_FORMAT,
    api: { version: API_V1 },
    registries: {
      blipKinds: [...BLIP_KINDS],
      blipStates: [...BLIP_STATES],
      blipStateLabels: BLIP_STATE_LABELS,
      essayBodyThreshold: ESSAY_BODY_THRESHOLD,
      notificationKinds: [...NOTIFICATION_KINDS],
      radarNotifyLevels: [...RADAR_NOTIFY_LEVELS],
      sessionClients: [...SESSION_CLIENTS],
      reactions: Object.entries(BLIP_REACTIONS)
        .map(([id, def]) => ({ id, emoji: def.emoji, label: def.label }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      accentFamilies: Object.entries(ACCENT_FAMILIES).map(([id, label]) => ({ id, label })),
      accents: Object.entries(RADAR_ACCENTS)
        .map(([id, def]) => ({
          id,
          label: def.label,
          family: def.family,
          from: def.from,
          to: def.to,
          ink: def.ink,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      glyphGroups: Object.entries(GLYPH_GROUPS).map(([id, label]) => ({ id, label })),
      glyphs: Object.entries(RADAR_GLYPHS)
        .map(([id, def]) => ({ id, label: def.label, group: def.group }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      templates: templateSnapshot(),
      themeAxes: THEME_AXES.map((axis) => ({
        key: axis.key,
        label: axis.label,
        options: [...axis.options],
      })),
      surfaces: Object.entries(RADAR_SURFACES)
        .map(([id, def]) => ({
          id,
          label: def.label,
          bg: def.bg,
          panel: def.panel,
          ink: def.ink,
          inkDim: def.inkDim,
          line: def.line,
          scheme: def.scheme,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      themePresets: Object.entries(THEME_PRESETS)
        .map(([id, preset]) => ({ id, label: preset.label, theme: preset.theme }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      defaultTheme: DEFAULT_RADAR_THEME,
      limits: LIMITS,
      mentionPattern: MENTION_PATTERN.source,
      actions: BLIP_ACTIONS.map((action) => ({
        id: action.id,
        label: action.label,
        acknowledgement: action.acknowledgement,
        icon: action.icon,
        reversible: action.reversible,
        mutates: action.mutates,
        confirm: action.reversible ? null : action.confirm,
      })),
    },
    vectors: {
      inference: inferenceVectors(),
      normalisation: normalisationVectors(),
      triage: triageVectors(),
      availability: availabilityVectors(),
    },
  };
}

export function snapshotJson(): string {
  return `${JSON.stringify(buildSnapshot(), null, 2)}\n`;
}
