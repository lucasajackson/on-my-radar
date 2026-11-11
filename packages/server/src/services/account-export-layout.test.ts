import { describe, expect, it } from 'vitest';
import { blipMarkdown, pathPart } from './account-export-layout.js';

describe('account download layout', () => {
  it.each([
    ['Product ideas', 'Product-ideas'],
    ['../../etc/passwd', 'etc-passwd'],
    ['.hidden', 'hidden'],
    ['Café · résumé', 'Cafe-resume'],
    ['日本語', ''],
    ['report.final.PDF', 'report.final.PDF'],
  ])('makes a safe path segment from %j', (input, expected) => {
    expect(pathPart(input, 60)).toBe(expected);
    expect(pathPart(input, 60)).toMatch(/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$/);
  });

  it('writes front matter, the body as captured, and relative links', () => {
    const text = blipMarkdown(
      {
        id: 'b1',
        title: 'A "quoted" title',
        kind: 'note',
        state: 'inbox',
        tags: ['one', 'two'],
        body: '# A "quoted" title\n\nBody text',
        pinned: false,
        created_at: '2026-10-06 12:00:00+00',
      },
      [{ name: 'notes [v2].pdf', link: 'files/notes-v2-.pdf' }],
      { original: 'emails/x.eml' },
    );
    expect(text).toBe(
      [
        '---',
        'title: "A \\"quoted\\" title"',
        'kind: "note"',
        'tags: ["one","two"]',
        'state: "inbox"',
        'created: "2026-10-06 12:00:00+00"',
        'id: "b1"',
        '---',
        '',
        '# A "quoted" title',
        '',
        'Body text',
        '',
        '## Email',
        '',
        '- [Original message (.eml)](<emails/x.eml>)',
        '',
        '## Attachments',
        '',
        '- [notes \\[v2\\].pdf](<files/notes-v2-.pdf>)',
        '',
      ].join('\n'),
    );
  });
});
