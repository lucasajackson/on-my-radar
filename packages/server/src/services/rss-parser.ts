import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';
import { SaxesParser } from 'saxes';

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export interface FeedEntry {
  hash: string;
  title: string;
  body: string;
  url: string | null;
  publishedAt: Date | null;
}
export interface ParsedFeed {
  title: string | null;
  entries: FeedEntry[];
}

function legacyIdentityText(value: string): string {
  // Keep the fallback identity stable for already imported items without GUIDs
  // or URLs. Presentation improvements must not make those entries import again.
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:p|div|br|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}
function plain(value: string): string {
  // Decode HTML entities while extracting feed content, never in the Markdown
  // renderer. Encoded markup is text rather than a second HTML parsing pass.
  return convert(value, {
    wordwrap: false,
    preserveNewlines: true,
    limits: { maxInputLength: MAX_FEED_BYTES },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
    ],
  }).trim();
}
function link(value: string, base: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString().slice(0, 2048)
      : null;
  } catch {
    return null;
  }
}

/** Strict XML, no DTD/custom entities, fixed byte and nesting limits. */
export function parseFeed(xml: string, base: string): ParsedFeed {
  if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error('Feed exceeds the 2 MiB limit');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Feed DTDs and custom entities are not supported');
  const parser = new SaxesParser({ xmlns: true });
  const stack: Array<{ name: string; text: string }> = [];
  const entries: FeedEntry[] = [];
  let title: string | null = null;
  let item: Record<string, string> | null = null;
  let itemDepth = 0;
  let root = '';
  parser.on('doctype', () => {
    throw new Error('Feed DTDs are not supported');
  });
  parser.on('opentag', (tag) => {
    if (stack.length >= 48) throw new Error('Feed XML nesting exceeds the limit');
    const name = tag.local.toLowerCase();
    stack.push({ name, text: '' });
    if (stack.length === 1) root = name;
    if (
      (root === 'rss' && name === 'item' && stack.length === 3) ||
      (root === 'feed' && name === 'entry' && stack.length === 2)
    ) {
      item = {};
      itemDepth = stack.length;
    }
    if (item && name === 'link' && stack.length === itemDepth + 1) {
      const attrs = Object.values(tag.attributes);
      const href = attrs.find((a) => a.local === 'href')?.value;
      const rel = attrs.find((a) => a.local === 'rel')?.value;
      if (href && (!rel || rel === 'alternate') && !item['link']) item['link'] = href;
    }
  });
  const text = (value: string) => {
    const node = stack[stack.length - 1];
    if (node) node.text += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    const node = stack.pop();
    if (!node) return;
    if (item && stack.length === itemDepth) {
      item[node.name] ??= node.text;
    } else if (item && stack.length === itemDepth - 1) {
      const entryTitle = plain(item['title'] ?? '').slice(0, 300);
      const rawBody =
        item['encoded'] ?? item['content'] ?? item['description'] ?? item['summary'] ?? '';
      const body = plain(rawBody).slice(0, 90_000);
      const url = link(item['link'] ?? '', base);
      const rawDate = item['published'] ?? item['pubdate'] ?? item['updated'] ?? item['date'];
      const date = rawDate ? new Date(rawDate) : null;
      const publishedAt = date && Number.isFinite(date.getTime()) ? date : null;
      const identity =
        item['id']?.trim() ||
        item['guid']?.trim() ||
        url ||
        `${legacyIdentityText(item['title'] ?? '').slice(0, 300)}\n${legacyIdentityText(rawBody).slice(0, 90_000)}\n${rawDate ?? ''}`;
      if (entryTitle || body || url)
        entries.push({
          hash: createHash('sha256').update(identity).digest('hex'),
          title: entryTitle,
          body,
          url,
          publishedAt,
        });
      if (entries.length > 20_000) throw new Error('Feed exceeds the 20,000 entry document limit');
      item = null;
    } else if (
      !item &&
      node.name === 'title' &&
      !title &&
      ((root === 'rss' && stack.length === 2) || (root === 'feed' && stack.length === 1))
    ) {
      title = plain(node.text).slice(0, 300) || null;
    }
    const parent = stack[stack.length - 1];
    // Preserve nested XHTML text without copying complete items into their parent.
    if (parent && item && stack.length > itemDepth) parent.text += ` ${node.text}`;
  });
  parser.write(xml).close();
  if (root !== 'rss' && root !== 'feed')
    throw new Error('That URL did not return an RSS 2.0 or Atom feed');
  return { title, entries };
}
