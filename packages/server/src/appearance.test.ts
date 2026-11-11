/**
 * The appearance vocabulary — accents and glyphs.
 *
 * These registries are stored by key and drawn by lookup, so the two things
 * worth pinning are that a stored key never disappears out from under a row, and
 * that an unknown key degrades rather than throws. Everything else — that the
 * hexes are pretty, that the groups are sensible — is a judgement, not an
 * assertion, and a test that encoded it would just be the file written twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ACCENT_FAMILY_KEYS,
  DEFAULT_RADAR_ACCENT,
  DEFAULT_RADAR_GLYPH,
  GLYPH_GROUP_KEYS,
  RADAR_ACCENTS,
  RADAR_ACCENT_KEYS,
  RADAR_GLYPHS,
  RADAR_GLYPH_KEYS,
  accentFor,
  accentsInFamily,
  glyphFor,
  glyphsInGroup,
  isRadarAccent,
  isRadarGlyph,
  matchesAccentQuery,
  matchesGlyphQuery,
} from '@onmyradar/contract';
import { closeDb, getDb, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import type { Actor } from './http.js';
import { createRadar, listRadars } from './services/radars.js';
import { createTopic, listTopics } from './services/topics.js';
import { must } from './errors.js';

/**
 * Every accent and glyph that has ever shipped, written out longhand.
 *
 * A key here is a value sitting in the `radars` table on production right now.
 * Renaming one does not fail a typecheck — it silently repaints somebody's radar
 * in the default colour, or with the default mark, and nothing anywhere says so.
 * This list is the only thing standing between a tidy-up and that.
 *
 * It is deliberately the registry written out a second time, in a second file.
 * That is the entire mechanism: a rename touches `domain.ts` and not this, so
 * the two disagree and a named test says which key moved. A list *derived* from
 * the registry would agree with any rename by construction and protect nothing,
 * which is the shape of hollow test this repo has been bitten by before.
 *
 * It used to hold ten accents and sixteen glyphs — the vocabulary as it stood
 * before `89eec73` took it to twenty-six and forty-eight — while `DESIGN.md` §22
 * said all twenty-six were written out here. Sixteen accents and thirty-two
 * glyphs could have been renamed with nothing failing, and the document said
 * they could not. Both halves are now true.
 *
 * Adding a key fails `covers every key currently in the registry` until it is
 * added here too. That is intended: a new token joining the vocabulary is a
 * one-line decision, and being unable to remove it silently afterwards is the
 * whole point.
 */
const SHIPPED_ACCENTS = [
  // warm
  'ember',
  'citrus',
  'honey',
  'cherry',
  'coral',
  'bubblegum',
  // earth
  'rust',
  'clay',
  'sand',
  'cocoa',
  // green
  'moss',
  'pine',
  'jade',
  'olive',
  // blue
  'lagoon',
  'sky',
  'cobalt',
  'denim',
  // violet
  'orchid',
  'lilac',
  'plum',
  'indigo',
  // neutral
  'slate',
  'ash',
  'graphite',
  'midnight',
];

const SHIPPED_GLYPHS = [
  // signal
  'radar',
  'target',
  'compass',
  'sparkles',
  'flame',
  'zap',
  'orbit',
  'telescope',
  // thinking
  'lightbulb',
  'brain',
  'book',
  'quote',
  'puzzle',
  'scroll',
  'glasses',
  'message',
  // making
  'wrench',
  'hammer',
  'rocket',
  'code',
  'cpu',
  'blocks',
  'pen',
  'flask',
  // living
  'coffee',
  'heart',
  'house',
  'gift',
  'dumbbell',
  'basket',
  'dog',
  'utensils',
  // outside
  'leaf',
  'mountain',
  'sun',
  'moon',
  'waves',
  'tent',
  'map',
  'plane',
  // media
  'camera',
  'music',
  'film',
  'gamepad',
  'mic',
  'palette',
  'tv',
  'headphones',
];

describe('the accent registry', () => {
  it('still contains every accent that has ever been stored', () => {
    for (const key of SHIPPED_ACCENTS) expect(isRadarAccent(key), key).toBe(true);
  });

  /**
   * The other direction, and the half that was missing.
   *
   * Without it the longhand list can fall behind the registry in silence — which
   * it had, by sixteen accents — and every new key ships unpinned. A test that
   * only walks its own list can only ever be as complete as the day it was
   * written.
   */
  it('covers every key currently in the registry, so nothing ships unpinned', () => {
    expect(SHIPPED_ACCENTS.slice().sort()).toEqual(RADAR_ACCENT_KEYS.slice().sort());
  });

  it('gives every accent a family the picker knows how to draw', () => {
    for (const key of RADAR_ACCENT_KEYS) {
      expect(ACCENT_FAMILY_KEYS).toContain(RADAR_ACCENTS[key].family);
    }
  });

  it('leaves no family empty, because an empty labelled row reads as a fault', () => {
    for (const family of ACCENT_FAMILY_KEYS) {
      expect(accentsInFamily(family).length).toBeGreaterThan(0);
    }
  });

  it('partitions the whole set across the families exactly once', () => {
    const grouped = ACCENT_FAMILY_KEYS.flatMap((family) => accentsInFamily(family));
    expect(grouped.slice().sort()).toEqual(RADAR_ACCENT_KEYS.slice().sort());
  });

  it('gives every accent three real colours', () => {
    for (const key of RADAR_ACCENT_KEYS) {
      const def = RADAR_ACCENTS[key];
      for (const value of [def.from, def.to, def.ink]) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('degrades an unknown accent to the default rather than throwing', () => {
    expect(accentFor('chartreuse')).toEqual(RADAR_ACCENTS[DEFAULT_RADAR_ACCENT]);
    expect(accentFor(null)).toEqual(RADAR_ACCENTS[DEFAULT_RADAR_ACCENT]);
    expect(accentFor(undefined)).toEqual(RADAR_ACCENTS[DEFAULT_RADAR_ACCENT]);
  });
});

describe('the glyph registry', () => {
  it('still contains every glyph that has ever been stored', () => {
    for (const key of SHIPPED_GLYPHS) expect(isRadarGlyph(key), key).toBe(true);
  });

  it('covers every key currently in the registry, so nothing ships unpinned', () => {
    expect(SHIPPED_GLYPHS.slice().sort()).toEqual(RADAR_GLYPH_KEYS.slice().sort());
  });

  it('partitions the whole set across the groups exactly once', () => {
    const grouped = GLYPH_GROUP_KEYS.flatMap((group) => glyphsInGroup(group));
    expect(grouped.slice().sort()).toEqual(RADAR_GLYPH_KEYS.slice().sort());
  });

  it('leaves no group empty', () => {
    for (const group of GLYPH_GROUP_KEYS) {
      expect(glyphsInGroup(group).length).toBeGreaterThan(0);
    }
  });

  it('gives every glyph a label that is not just the id shouted back', () => {
    for (const key of RADAR_GLYPH_KEYS) {
      expect(RADAR_GLYPHS[key].label.length).toBeGreaterThan(0);
    }
  });

  it('degrades an unknown glyph to the default rather than throwing', () => {
    expect(glyphFor('unicorn')).toEqual(RADAR_GLYPHS[DEFAULT_RADAR_GLYPH]);
    expect(glyphFor(null)).toEqual(RADAR_GLYPHS[DEFAULT_RADAR_GLYPH]);
  });
});

describe('the picker search', () => {
  it('matches everything on an empty query, so the panel opens full', () => {
    for (const key of RADAR_GLYPH_KEYS) expect(matchesGlyphQuery(key, '   ')).toBe(true);
    for (const key of RADAR_ACCENT_KEYS) expect(matchesAccentQuery(key, '')).toBe(true);
  });

  it('finds a glyph by a word that is not its id', () => {
    // The whole reason `keywords` exists: nobody types "flask" when what they
    // are looking for is the science one.
    expect(matchesGlyphQuery('flask', 'science')).toBe(true);
    expect(matchesGlyphQuery('basket', 'groceries')).toBe(true);
    expect(matchesGlyphQuery('scroll', 'essay')).toBe(true);
  });

  it('finds a glyph by its group, so "media" lists the media ones', () => {
    const hits = RADAR_GLYPH_KEYS.filter((key) => matchesGlyphQuery(key, 'media'));
    expect(hits.sort()).toEqual(glyphsInGroup('media').sort());
  });

  it('finds an accent by its family name', () => {
    const hits = RADAR_ACCENT_KEYS.filter((key) => matchesAccentQuery(key, 'earth'));
    expect(hits.sort()).toEqual(accentsInFamily('earth').sort());
  });

  it('is case-insensitive, because nobody types in lower case on a phone', () => {
    expect(matchesGlyphQuery('rocket', 'ROCKET')).toBe(true);
    expect(matchesAccentQuery('cobalt', 'Cobalt')).toBe(true);
  });

  it('returns nothing for a word in neither vocabulary', () => {
    expect(RADAR_GLYPH_KEYS.some((key) => matchesGlyphQuery(key, 'zzzzz'))).toBe(false);
    expect(RADAR_ACCENT_KEYS.some((key) => matchesAccentQuery(key, 'zzzzz'))).toBe(false);
  });
});

/**
 * The same degradation, where it matters: the DTO a radar or a topic is read
 * through. The glyph column has no CHECK, so a key only a later build knows —
 * or a rename that slipped past the list above — reaches this build as a
 * string, and it must come out as the default mark rather than as a value
 * typed `RadarGlyph` that no icon lookup can draw.
 */
describe.skipIf(!process.env['DATABASE_URL'])('an unknown stored key, read back', () => {
  let owner: Actor;
  beforeAll(async () => {
    process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `appearance-${Date.now()}@example.test`, state: 'active' })
      .returning();
    owner = { user: must(user), kind: 'user' };
  }, 30_000);
  afterAll(async () => {
    await closeDb();
  });

  it('reads a radar and a topic with a glyph from the future as the default', async () => {
    const radar = await createRadar(owner, { name: 'From the future' });
    const topic = await createTopic(owner, { name: 'Also from the future' });
    await getDb()
      .update(schema.radars)
      .set({ glyph: 'hologram', accent: 'ultraviolet-2' })
      .where(eq(schema.radars.id, radar.id));
    await getDb()
      .update(schema.topics)
      .set({ glyph: 'hologram' })
      .where(eq(schema.topics.id, topic.id));
    const read = (await listRadars(owner)).find((item) => item.id === radar.id);
    expect(read).toMatchObject({ glyph: DEFAULT_RADAR_GLYPH, accent: DEFAULT_RADAR_ACCENT });
    const group = (await listTopics(owner)).find((item) => item.id === topic.id);
    expect(group?.glyph).toBe(DEFAULT_RADAR_GLYPH);
  });
});
