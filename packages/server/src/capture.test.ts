/**
 * The capture rules — what the server infers when a caller gives it only text.
 *
 * These are the behaviours a person and an agent both rely on, so they are
 * tested at the level they are shared: the pure helpers in @onmyradar/contract.
 */
import { describe, expect, it } from 'vitest';
import {
  bodyWithoutTitleHeading,
  deriveBlipKind,
  headingTitle,
  extractInlineTags,
  normalizeEmail,
  normalizeTag,
  normalizeTags,
  slugify,
  soleUrl,
  firstUrl,
  bodyWithoutLeadUrl,
  LIMITS,
  MAX_NEXT_LENGTH,
  safeNextPath,
} from '@onmyradar/contract';

describe('tag normalization', () => {
  it('folds the ways a person might write the same tag into one', () => {
    expect(normalizeTag('#Side Projects')).toBe('side-projects');
    expect(normalizeTag('side-projects')).toBe('side-projects');
    expect(normalizeTag('  SIDE   PROJECTS ')).toBe('side-projects');
  });

  it('keeps non-latin tags intact rather than emptying them', () => {
    expect(normalizeTag('#日本語')).toBe('日本語');
  });

  it('drops punctuation-only tags instead of producing empty ones', () => {
    expect(normalizeTag('###')).toBe('');
    expect(normalizeTags(['###', '  ', '#ok'])).toEqual(['ok']);
  });

  it('de-duplicates and caps at the documented limit', () => {
    const many = Array.from({ length: LIMITS.tagsPerBlip + 10 }, (_, i) => `tag${i}`);
    expect(normalizeTags([...many, 'tag0'])).toHaveLength(LIMITS.tagsPerBlip);
  });
});

describe('inline tags', () => {
  it('lifts hashtags out of body text', () => {
    expect(extractInlineTags('Build a thing for #voice memos and #tasks')).toEqual([
      'voice',
      'tasks',
    ]);
  });

  it('ignores a # that is not a tag', () => {
    expect(extractInlineTags('issue #1234 is fixed')).toEqual([]);
    expect(extractInlineTags('C# is a language')).toEqual([]);
    expect(extractInlineTags('a##b')).toEqual([]);
  });
});

describe('inline tags need a letter', () => {
  it('leaves a number in prose alone, and keeps a tag that has a letter', () => {
    expect(extractInlineTags('ranks #26 in the results')).toEqual([]);
    expect(extractInlineTags('plan for #q4 and #2026-q4 but not #26')).toEqual(['q4', '2026-q4']);
    expect(extractInlineTags('see #26 #voice')).toEqual(['voice']);
  });

  it('a link filed under a number is still a bare link only with a real tag', () => {
    expect(soleUrl('https://example.com/a #reading')).toBe('https://example.com/a');
    expect(soleUrl('https://example.com/a #26')).toBeNull();
  });
});

describe('kind derivation', () => {
  it('treats a bare url as a link', () => {
    expect(deriveBlipKind({ body: '', url: 'https://example.com' })).toBe('link');
  });

  it('does not call a note with a link in it a link', () => {
    expect(
      deriveBlipKind({ body: 'look at https://example.com', url: 'https://example.com' }),
    ).toBe('note');
  });

  it('calls a long body an essay', () => {
    expect(deriveBlipKind({ body: 'x'.repeat(1000) })).toBe('essay');
    expect(deriveBlipKind({ body: 'short' })).toBe('note');
  });

  it('prefers attachments over text when deciding', () => {
    expect(
      deriveBlipKind({ body: 'a photo', attachmentContentTypes: ['image/png', 'image/jpeg'] }),
    ).toBe('image');
    expect(deriveBlipKind({ body: 'a doc', attachmentContentTypes: ['application/pdf'] })).toBe(
      'file',
    );
    // A mixed set is a file set: one image does not make it a photo blip.
    expect(
      deriveBlipKind({ body: '', attachmentContentTypes: ['image/png', 'application/pdf'] }),
    ).toBe('file');
  });
});

describe('soleUrl', () => {
  it('matches only a body that is nothing but one url', () => {
    expect(soleUrl('https://example.com')).toBe('https://example.com/');
    expect(soleUrl('  https://example.com/x?y=1  ')).toBe('https://example.com/x?y=1');
    expect(soleUrl('see https://example.com')).toBeNull();
    expect(soleUrl('https://a.com https://b.com')).toBeNull();
  });

  it('lets hashtags sit beside the url, and keeps a fragment as part of it', () => {
    expect(soleUrl('https://example.com/a #reading')).toBe('https://example.com/a');
    expect(soleUrl('#reading https://example.com/a #later')).toBe('https://example.com/a');
    expect(soleUrl('https://example.com/a#section')).toBe('https://example.com/a#section');
    expect(soleUrl('https://example.com/a #reading and a thought')).toBeNull();
    expect(soleUrl('#reading')).toBeNull();
  });

  it('refuses non-http schemes', () => {
    expect(soleUrl('javascript:alert(1)')).toBeNull();
    expect(soleUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('firstUrl — the looser reading a reading list asks for', () => {
  it('finds the link in a body that also says why it was saved', () => {
    expect(firstUrl('https://example.com/essay — because Ben mentioned it')).toBe(
      'https://example.com/essay',
    );
    expect(firstUrl('worth reading: https://example.com/x')).toBe('https://example.com/x');
  });

  it('leaves the sentence punctuation behind', () => {
    expect(firstUrl('read https://example.com/x, then this')).toBe('https://example.com/x');
    expect(firstUrl('read https://example.com/x.')).toBe('https://example.com/x');
  });

  it('unwraps a markdown link without eating a balanced one', () => {
    expect(firstUrl('[title](https://example.com/x)')).toBe('https://example.com/x');
    // A closer that is matched inside the URL is part of it — a Wikipedia
    // disambiguation path is the case that makes this worth counting rather
    // than trimming every trailing bracket.
    expect(firstUrl('https://example.com/Thing_(disambiguation)')).toBe(
      'https://example.com/Thing_(disambiguation)',
    );
  });

  it('takes the first of several, and nothing at all from prose', () => {
    expect(firstUrl('https://a.example/1 and https://b.example/2')).toBe('https://a.example/1');
    expect(firstUrl('no link here, example.com does not count')).toBeNull();
    expect(firstUrl('')).toBeNull();
  });

  it('refuses a scheme that is not http or https', () => {
    // The same restriction the markdown renderer applies to link targets.
    expect(firstUrl('javascript:alert(1)')).toBeNull();
    expect(firstUrl('ftp://example.com/x')).toBeNull();
  });
});

describe('bodyWithoutLeadUrl — not printing the link three times', () => {
  it('takes the link off the front and the separator with it', () => {
    const body = 'https://example.com/x — because Ben mentioned it';
    expect(bodyWithoutLeadUrl(body, firstUrl(body))).toBe('because Ben mentioned it');
  });

  it('takes it off the end too', () => {
    const body = 'worth reading: https://example.com/x';
    expect(bodyWithoutLeadUrl(body, firstUrl(body))).toBe('worth reading');
  });

  it('empties a body that was nothing but the link', () => {
    // The preview card *is* the blip at that point.
    expect(bodyWithoutLeadUrl('https://example.com/x', 'https://example.com/x')).toBe('');
  });

  it('leaves a URL in the middle of a sentence alone', () => {
    // Cutting a hole in a sentence to save a repetition is worse than the
    // repetition.
    const body = 'the note at https://example.com/x explains it';
    expect(bodyWithoutLeadUrl(body, firstUrl(body))).toBe(body);
  });

  it('leaves the body alone when the blip carries a different url', () => {
    // An explicitly-set `url` that is not the one in the text: the prose is
    // talking about something else and must survive intact.
    const body = 'https://example.com/x is related';
    expect(bodyWithoutLeadUrl(body, 'https://example.com/other')).toBe(body);
  });

  it('does nothing at all without a url', () => {
    expect(bodyWithoutLeadUrl('just a thought', null)).toBe('just a thought');
  });
});

describe('slugify', () => {
  it('produces a url-safe slug', () => {
    expect(slugify('New App Ideas!')).toBe('new-app-ideas');
    expect(slugify('Café Décor')).toBe('cafe-decor');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('radar');
    expect(slugify('')).toBe('radar');
  });
});

describe('normalizeEmail', () => {
  it('lower-cases and trims so the unique index actually holds', () => {
    expect(normalizeEmail('  Lucas@Example.COM ')).toBe('lucas@example.com');
  });
});

describe('safeNextPath', () => {
  it('accepts ordinary in-app destinations', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/radar/abc-123')).toBe('/radar/abc-123');
    expect(safeNextPath('/settings')).toBe('/settings');
  });

  it('still allows the MCP authorization bounce', () => {
    // /login?next=/oauth/authorize?... is a legitimate flow; banning it would
    // break connecting a remote agent.
    expect(safeNextPath('/oauth/authorize?client_id=x&state=y')).toBe(
      '/oauth/authorize?client_id=x&state=y',
    );
  });

  it('refuses /login, which is what made the redirect recurse', () => {
    expect(safeNextPath('/login')).toBeNull();
    expect(safeNextPath('/login?next=%2Flogin%3Fnext%3D%252Flogin')).toBeNull();
    expect(safeNextPath('/waiting')).toBeNull();
  });

  it('refuses API paths, which are never a page', () => {
    expect(safeNextPath('/api/auth/oidc/start')).toBeNull();
  });

  it('refuses anything that leaves the origin', () => {
    expect(safeNextPath('//evil.example')).toBeNull();
    expect(safeNextPath('https://evil.example')).toBeNull();
    expect(safeNextPath('\\\\evil.example')).toBeNull();
    expect(safeNextPath('/\\evil.example')).toBeNull();
  });

  it('refuses control and whitespace characters, which a browser strips before it resolves the path', () => {
    // `/\t/evil.example` parses as `//evil.example`.
    for (const next of [
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/ /evil.example',
    ]) {
      expect(safeNextPath(next), JSON.stringify(next)).toBeNull();
    }
    expect(safeNextPath('/radar/a\u0000b')).toBeNull();
    expect(safeNextPath('/radar/a\u007fb')).toBeNull();
    expect(safeNextPath('/radar/a b')).toBeNull();
    // Encoded forms are inert text, not characters.
    expect(safeNextPath('/radar/a%20b')).toBe('/radar/a%20b');
  });

  it('refuses a destination longer than the cap', () => {
    expect(safeNextPath(`/${'x'.repeat(MAX_NEXT_LENGTH)}`)).toBeNull();
  });

  it('does not grow when fed its own output', () => {
    // The regression itself: each pass nested the previous URL and re-encoded
    // it, so the request line grew until nginx answered 414.
    let next: string | null = '/';
    for (let i = 0; i < 50; i += 1) {
      const candidate = `/login?next=${encodeURIComponent(next ?? '/')}`;
      next = safeNextPath(candidate);
      expect(next).toBeNull();
    }
  });
});

describe('title headings', () => {
  it('takes a title only from a real markdown heading', () => {
    expect(headingTitle('# Kanban template\n\nBody text')).toBe('Kanban template');
    expect(headingTitle('### Deep but still a heading')).toBe('Deep but still a heading');
    // A long first sentence is not a title; deriving one prints it twice.
    expect(headingTitle('This is just a sentence.\n\nAnd more.')).toBeNull();
    expect(headingTitle('#nothashtag is a tag, not a heading')).toBeNull();
    // Longer than a title may be: storing it made a blip whose own title the
    // edit schema refuses to take back, so it stays body text.
    const long = 'x'.repeat(LIMITS.blipTitle + 1);
    expect(headingTitle(`# ${long}\n\nbody`)).toBeNull();
    expect(bodyWithoutTitleHeading(`# ${long}\n\nbody`, null)).toBe(`# ${long}\n\nbody`);
    expect(headingTitle(`# ${'x'.repeat(LIMITS.blipTitle)}`)).toHaveLength(LIMITS.blipTitle);
  });

  it('strips the heading that became the title, and nothing else', () => {
    // The bug this prevents: a blip whose body starts with "# X" showing X as
    // its title and then again as the first line of its own body.
    expect(bodyWithoutTitleHeading('# X\n\nbody', 'X')).toBe('body');
    // A title the user set by hand is unrelated to the heading; leave it alone.
    expect(bodyWithoutTitleHeading('# X\n\nbody', 'Something else')).toBe('# X\n\nbody');
    expect(bodyWithoutTitleHeading('no heading here', 'Manual title')).toBe('no heading here');
    expect(bodyWithoutTitleHeading('# X', 'X')).toBe('');
  });
});
