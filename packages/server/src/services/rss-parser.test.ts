import { describe, expect, it } from 'vitest';
import { MAX_FEED_BYTES, parseFeed } from './rss-parser.js';

describe('bounded RSS/Atom parsing', () => {
  it('decodes named and numeric HTML entities once without changing fallback dedupe identities', () => {
    const feed = parseFeed(
      `<rss><channel><item><title><![CDATA[News &mdash; today]]></title><description><![CDATA[<p>A&zwnj;B costs &#36;5 &#x2014; &copy; today.</p><p>&lt;img src=x onerror=alert(1)&gt; &amp;lt;b&amp;gt;</p><script>evil()</script>]]></description></item></channel></rss>`,
      'https://feed.test',
    );
    expect(must(feed.entries[0]).title).toBe('News — today');
    expect(must(feed.entries[0]).body).toBe(
      'A\u200cB costs $5 — © today.\n\n<img src=x onerror=alert(1)> &lt;b&gt;',
    );
    const oldIdentity =
      'News &mdash; today\nA&zwnj;B costs &#36;5 &#x2014; &copy; today.\n\n<img src=x onerror=alert(1)> <b>\n';
    expect(must(feed.entries[0]).hash).toBe(createHash('sha256').update(oldIdentity).digest('hex'));
  });
  it('reads RSS CDATA, encoded content, stable GUIDs and dates', () => {
    const feed = parseFeed(
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>A &amp; B</title><item><guid>same</guid><title>First</title><link>/post</link><pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Hello</p><script>evil()</script>]]></content:encoded></item></channel></rss>`,
      'https://feed.test/rss',
    );
    expect(feed.title).toBe('A & B');
    expect(feed.entries[0]).toMatchObject({
      title: 'First',
      body: 'Hello',
      url: 'https://feed.test/post',
      publishedAt: new Date('2026-09-18T12:00:00Z'),
    });
    const edited = parseFeed(
      '<rss><channel><item><guid>same</guid><title>Edited</title></item></channel></rss>',
      'https://feed.test',
    );
    expect(must(edited.entries[0]).hash).toBe(must(feed.entries[0]).hash);
  });
  it('reads Atom alternate links, nested XHTML and rejects executable link schemes', () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>x</id><title>Entry</title><link rel="self" href="/self"/><link rel="alternate" href="/article"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <b>world</b></p></div></content></entry><entry><title>Unsafe link</title><link href="javascript:alert(1)"/></entry></feed>`,
      'https://atom.test/feed',
    );
    expect(must(feed.entries[0]).url).toBe('https://atom.test/article');
    expect(must(feed.entries[0]).body).toMatch(/Hello\s+world/);
    expect(must(feed.entries[1]).url).toBeNull();
  });
  it('refuses DTDs/entities, malformed XML, excessive nesting and oversized feeds', () => {
    expect(() =>
      parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'https://x.test'),
    ).toThrow(/DTD/);
    expect(() => parseFeed('<rss><channel>&unknown;</channel></rss>', 'https://x.test')).toThrow();
    expect(() => parseFeed('<rss><channel></rss>', 'https://x.test')).toThrow();
    expect(() =>
      parseFeed('<rss>' + '<x>'.repeat(49) + '</x>'.repeat(49) + '</rss>', 'https://x.test'),
    ).toThrow(/nesting/);
    expect(() => parseFeed(' '.repeat(MAX_FEED_BYTES + 1), 'https://x.test')).toThrow(/2 MiB/);
    expect(() => parseFeed('<html/>', 'https://x.test')).toThrow(/RSS/);
  });
});
import { createHash } from 'node:crypto';
import { must } from '../errors.js';
