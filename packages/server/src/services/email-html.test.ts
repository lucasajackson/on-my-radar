import { describe, expect, it } from 'vitest';
import {
  emailHtmlText,
  isInlineEmailImage,
  renderEmailHtml,
  sanitizeEmailHtml,
} from './email-html.js';
describe('email formatting boundary', () => {
  it('preserves readable tables and safe inline formatting while removing active markup and CSS fetches', () => {
    const html = sanitizeEmailHtml(
      `<head><style>@import 'https://tracker.test/a';</style></head><script>alert(1)</script><svg onload="alert(1)"></svg><form action="https://tracker.test"><input></form><table style="background-color:#fff;border-collapse:collapse"><tr><td style="color:rgb(1,2,3);padding:12px;background:url(https://tracker.test);width:expression(alert(1));position:fixed;--x:url(https://tracker.test)"><b>Readable</b></td></tr></table><img srcset="https://tracker.test 2x" src="data:image/svg+xml,bad" onerror="alert(1)"><a href="javascript:alert(1)">bad link</a>`,
    );
    expect(html).toContain('<table style="background-color:#fff;border-collapse:collapse">');
    expect(html).toContain('color:rgb(1,2,3);padding:12px');
    expect(html).toContain('<b>Readable</b>');
    expect(html).not.toMatch(
      /script|onerror|onload|srcset|tracker\.test|expression|position|--x|javascript|<form|<input|<svg/,
    );
  });
  it('blocks remote images until consent and resolves only explicitly mapped CIDs', () => {
    const stored = sanitizeEmailHtml(
      '<img src="cid:logo@example"><img src="cid:missing"><img src="https://images.example/a.png"><img src="//tracker.example/x"><a href="https://example.org">Visit</a>',
    );
    expect(stored).not.toContain('src="https:');
    const urls = new Map([['logo@example', 'https://storage.example/logo?token=private']]);
    const hidden = renderEmailHtml(stored, urls, false);
    expect(hidden.remoteImagesBlocked).toBe(1);
    expect(hidden.imageOrigins).toEqual(['https://storage.example']);
    expect(hidden.html).not.toContain('images.example');
    expect(hidden.html).not.toContain('cid:');
    const visible = renderEmailHtml(stored, urls, true);
    expect(visible.imageOrigins).toEqual(['https://storage.example', 'https://images.example']);
    expect(visible.html).toContain('rel="noopener noreferrer nofollow"');
  });
  it('keeps unsupported or unreferenced inline files downloadable', () => {
    const html = sanitizeEmailHtml('<img src="cid:logo">');
    expect(isInlineEmailImage(html, 'image/png', 'logo')).toBe(true);
    expect(isInlineEmailImage(html, 'application/pdf', 'logo')).toBe(false);
    expect(isInlineEmailImage(html, 'image/svg+xml', 'logo')).toBe(false);
    expect(isInlineEmailImage(html, 'image/png', 'unreferenced')).toBe(false);
  });
  it('handles escaped CSS and entity URLs without a fetch-capable property', () => {
    const html = sanitizeEmailHtml(
      '<p style="background-image:u\\72l(https://evil.test);background:im\\61ge-set(url(https://evil.test));color:var(--x);font-family:url(https://evil.test)">hello &amp; goodbye</p><a href="&#106;avascript:alert(1)">link</a>',
    );
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('javascript');
    expect(emailHtmlText('<p>One &amp; two</p><p>Three</p>')).toBe('One & two\n\nThree');
  });
  it('applies the ingest allow-list again at render, whatever reached storage', () => {
    const hostile =
      '<p onclick="steal()" style="color:red;background:url(https://evil.test/x);position:fixed" id="x" class="y">hi</p>' +
      '<a href="javascript:alert(1)" onmouseover="x()" name="n">bad</a>' +
      '<a href="https://ok.example/page" target="_self" ping="https://evil.test/p">ok</a>' +
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>' +
      '<form action="https://evil.test/post" onsubmit="x()"><button formaction="https://evil.test">go</button></form>' +
      '<img src="data:image/svg+xml,bad" onerror="alert(1)" srcset="https://evil.test 2x">' +
      '<img src="cid:logo" onload="x()" style="width:10px;behavior:url(x)">' +
      '<table background="https://evil.test/bg" onclick="x()"><tr><td bgcolor="red">c</td></tr></table>';
    const { html } = renderEmailHtml(
      hostile,
      new Map([['logo', 'https://storage.example/l']]),
      true,
    );
    expect(html).not.toMatch(
      /onclick|onmouseover|onerror|onload|onsubmit|srcdoc|formaction|srcset|evil\.test|javascript|ping=|background=|bgcolor|<iframe|<form|<button|position|behavior|class=|id=|name=|data:/,
    );
    expect(html).toContain('color:red');
    expect(html).toContain('href="https://ok.example/page"');
    expect(html).toContain('src="https://storage.example/l"');
  });
});
