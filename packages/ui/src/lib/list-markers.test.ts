import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Tailwind's preflight sets list-style: none, and nothing else gave a blip body
// its markers back. Declared in the one `.blip-body` rule so every template's
// own layout classes (board card, timeline post) keep their own say.
it('gives blip-body lists their markers back', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.blip-body ul \{\s*list-style: disc;/);
  expect(css).toMatch(/\.blip-body ol \{\s*list-style: decimal;/);
});
