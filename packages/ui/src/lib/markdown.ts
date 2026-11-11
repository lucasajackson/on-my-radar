/**
 * A deliberately small markdown renderer for blip bodies.
 *
 * Safety comes from ordering, not from filtering: the source is HTML-escaped in
 * full *first*, so no markup a user typed can survive, and only then is a fixed
 * set of known-safe tags introduced. Link targets are additionally restricted to
 * http, https and mailto, which is the only place a URL reaches an attribute.
 *
 * Hashtags are the one exception to "no URL is ever built from user text": a
 * `#tag` becomes a same-origin link to that tag's page. The href is not the
 * user's text — it is `normalizeTag`'s output, which is letters, numbers and
 * hyphens only, then percent-encoded. There is no way for a scheme to appear in
 * it, so the restriction above is not being weakened.
 */
import {
  INLINE_TAG_NAME,
  MENTION_PATTERN,
  mentionKey,
  normalizeTag,
  normalizeText,
  replaceMarkers,
  unreadBlocks,
  type AmendMarker,
  type MentionDto,
  type UnreadBlock,
} from '@onmyradar/contract';

/** Where a hashtag points. Kept here so the renderer and the router agree. */
export function tagHref(tag: string): string {
  return `/t/${encodeURIComponent(normalizeTag(tag))}`;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  // A bare domain typed without a scheme is common; assume https rather than
  // emitting a relative link that would resolve inside the app.
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

/**
 * Inline pass, run on already-escaped text.
 *
 * Code spans are lifted out behind a placeholder first so their contents are not
 * then read as emphasis or links. The placeholder contains a literal angle
 * bracket, which cannot occur in escaped source — so it can never collide with
 * something the user actually typed.
 */
/**
 * Handles to the account they resolved to, keyed every way that account can be
 * written.
 *
 * The DTO carries one handle — the local part of the address — but a person can
 * equally be addressed by the slug of their display name, and the server resolves
 * both. Deriving the second key here rather than widening the wire keeps the two
 * ends in step without sending the same information twice.
 */
function mentionIndex(mentions: readonly MentionDto[]): Map<string, MentionDto> {
  const index = new Map<string, MentionDto>();
  for (const mention of mentions) {
    index.set(mentionKey(mention.handle), mention);
    const named = mentionKey(mention.name);
    if (named) index.set(named, mention);
    /*
      ...and any other key the server says this principal answers to.

      That is the owner-qualified agent handle. An agent answers to `@claude` and
      to `@ada.claude`, and the stored row does not remember which was typed —
      deliberately, so a rename re-renders. Without this the qualified form
      notified correctly and then came back as plain text: the notification
      arrived, the highlight did not, and the two disagreed on the same screen.
      Found by writing `@ada.claude` in a real comment and looking at it.
    */
    for (const alias of mention.aliases ?? []) {
      const key = mentionKey(alias);
      if (key) index.set(key, mention);
    }
  }
  return index;
}

function inline(text: string, tagLinks: boolean, mentions: readonly MentionDto[]): string {
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `<CODESPAN${codeSpans.length - 1}>`;
  });

  /*
    Every tag that carries an attribute is held behind a placeholder the moment
    it is built, exactly like a code span, and put back last.

    The passes below all run over this function's own output. When the anchors
    stayed in the string, the bare-URL pass matched *inside* an href a markdown
    link had just built — `[x](https://a/(https://b/style=…)` — consumed the
    closing quote and wrote a second one, so the rest of the author's text became
    attributes. The mention pass could do the same through `(@handle`. Escaping
    first makes user markup inert; it says nothing about markup this function
    builds and then feeds to its own later passes. Holding the tag makes an
    attribute unreachable by construction rather than by each regex's care.
  */
  const held: string[] = [];
  const hold = (html: string) => {
    held.push(html);
    return `<HELD${held.length - 1}>`;
  };

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const safe = safeHref(href);
    // Only the opening tag is held: the label is prose, and may be emphasised.
    return safe
      ? `${hold(`<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">`)}${label}</a>`
      : match;
  });

  // Bare URLs. Held whole — the label is the URL, and emphasis inside it is an
  // underscore in a path, not something the author meant to italicise.
  out = out.replace(
    /(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    (_m, lead: string, url: string) =>
      `${lead}${hold(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`)}`,
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Hashtags become links to the tag's own page — every blip carrying it, across
  // every radar. Shown in the radar's accent, matching how they are stored.
  out = out.replace(
    new RegExp(`(^|\\s)#(${INLINE_TAG_NAME})`, 'gu'),
    (match, lead: string, tag: string) => {
      const normalized = normalizeTag(tag);
      // A tag that normalises to nothing is not a tag; leave the text alone.
      if (!normalized) return match;
      // On a public page the tag page is behind sign-in, so a link there would
      // send a stranger to a login screen. Colour it and stop.
      return tagLinks
        ? `${lead}${hold(`<a class="tag-link" href="${tagHref(tag)}">#${tag}</a>`)}`
        : `${lead}${hold(`<span class="accent-text">#${tag}</span>`)}`;
    },
  );

  // Mentions, last, and deliberately after the link passes: a handle is only a
  // handle when it starts the line or follows a space or a bracket, so it can
  // never be sitting inside an href this function has just built. The pattern is
  // imported rather than written again — the server decided what a mention *is*
  // when it resolved one, and a second copy of the rule here would eventually
  // disagree with it, showing a highlight that notified nobody or the reverse.
  //
  // Only a handle the server actually resolved is marked up. An unresolved one
  // stays plain text, which is exactly what it means: nobody on this radar is
  // called that.
  if (mentions.length > 0) {
    const index = mentionIndex(mentions);
    out = out.replace(new RegExp(MENTION_PATTERN), (match, lead: string, handle: string) => {
      const found = index.get(mentionKey(handle));
      if (!found) return match;
      // The *current* name, not the text that was typed — which is the whole
      // reason the resolution is stored rather than parsed back out of the body.
      // It has not been through `escapeHtml` (it comes from the DTO, not from
      // the escaped source), so it is escaped here.
      return `${lead}<span class="mention">@${escapeHtml(found.name)}</span>`;
    });
  }

  return out
    .replace(/<HELD(\d+)>/g, (_m, index: string) => held[Number(index)] ?? '')
    .replace(/<CODESPAN(\d+)>/g, (_m, index: string) => codeSpans[Number(index)] ?? '');
}

const isTableRow = (line: string) => /^\s*\|?.*\|.*$/.test(line) && line.trim() !== '';
const isTableRule = (line: string) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
/** A row's cells, without the optional outer pipes. `\|` stays a literal pipe. */
function cells(line: string): string[] {
  const trimmed = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * How amendment markers (`:amend[quote]{adr=… with="…"}`) are drawn. The lane of
 * each ADR decides: accepted strikes the quote (or, "amended", shows the
 * replacement), proposed highlights it, anything else is the plain quote.
 */
export interface AmendContext {
  view: 'written' | 'amended';
  adrs: ReadonlyMap<string, { label: string; lane: string | null }>;
}

/** Built from the marker's parts, each escaped here: the markers never meet the markdown passes. */
function amendHtml(marker: AmendMarker, ctx: AmendContext): string {
  const layers = marker.layers.map((layer) => ({
    ...layer,
    ...(ctx.adrs.get(layer.adr) ?? { label: 'ADR', lane: null }),
  }));
  const refs = (lane: string) =>
    layers
      .filter((l) => l.lane === lane)
      .map(
        (l) =>
          `<sup class="amend-ref"><a href="#adr-${l.adr}" data-adr="${escapeHtml(l.label)}" aria-label="${escapeHtml(l.label)}"></a></sup>`,
      )
      .join('');
  const live = layers.filter((l) => l.lane === 'accepted');
  const last = live[live.length - 1];
  const shown = !last
    ? escapeHtml(marker.quote)
    : ctx.view === 'amended'
      ? // `data-was`: how many characters of the charter this stands for, so the page can count
        // a place past it. Not the words: an amended page does not carry the text it replaced.
        `<ins class="amend-with" data-was="${normalizeText(marker.quote).length}">${escapeHtml(last.with)}</ins>${refs('accepted')}`
      : `<del class="amend-struck">${escapeHtml(marker.quote)}</del>${refs('accepted')}`;
  return layers.some((l) => l.lane === 'proposed')
    ? `<mark class="amend-proposed">${shown}</mark>${refs('proposed')}`
    : shown;
}

/** Block pass. Returns an HTML string safe to inject. */
export function renderMarkdown(
  source: string,
  options: {
    tagLinks?: boolean;
    mentions?: readonly MentionDto[];
    /**
     * A single newline is a line break, not a space. Markdown joins a
     * paragraph's lines; a comment is typed like a message, where Enter means a
     * new line, and "one⏎two⏎three" arriving as "one two three" read as the
     * app eating what was written. The `<br>` is added between lines that have
     * each been escaped and rendered already, so it is one more known-safe tag
     * introduced after escaping — the same ordering everything else here uses.
     */
    breaks?: boolean;
    amend?: AmendContext;
  } = {},
): string {
  const tagLinks = options.tagLinks ?? true;
  const breaks = options.breaks ?? false;
  const mentions = options.mentions ?? [];
  /*
    Markers are lifted out before escaping and put back last, behind placeholders
    that survive the passes (a pipe in a replacement cannot split a table cell).
    The source goes to the shared parser exactly as stored, so the renderer sees
    the markers the server's guard sees, no more. The placeholder carries a nonce
    chosen per render, so text in the source cannot forge one.
  */
  const drawn: string[] = [];
  const nonce = Math.random().toString(36).slice(2);
  const text = source.includes(':amend[')
    ? replaceMarkers(source, (marker) => {
        drawn.push(amendHtml(marker, options.amend ?? { view: 'written', adrs: new Map() }));
        return `\uE000${nonce}:${drawn.length - 1}\uE001`;
      })
    : source;
  const lines = escapeHtml(text.replace(/\r\n/g, '\n')).split('\n');
  const out: string[] = [];

  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCodeFence = false;
  let codeBuffer: string[] = [];
  let quoteBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(
        `<p>${
          breaks
            ? paragraph.map((line) => inline(line, tagLinks, mentions)).join('<br>')
            : inline(paragraph.join(' '), tagLinks, mentions)
        }</p>`,
      );
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quoteBuffer.length > 0) {
      out.push(`<blockquote>${inline(quoteBuffer.join(' '), tagLinks, mentions)}</blockquote>`);
      quoteBuffer = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    closeList();
    flushQuote();
  };

  /*
    The charter's reading view must show what the charter's text is: blocks the projection leaves
    out (any code block, fenced with backticks or tildes or indented; an HTML block; a link
    definition) are not prose, so the page cannot draw them as paragraphs, or the words in them
    would be taken for words the charter holds. They come from the projection's own walk.
  */
  const unread = new Map<number, UnreadBlock>();
  if (options.amend)
    for (const block of unreadBlocks(text.replace(/\r\n/g, '\n')))
      if (block.type !== 'thematicBreak') unread.set(block.startLine - 1, block);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const skipped = unread.get(index);
    if (skipped) {
      flushAll();
      out.push(
        skipped.type === 'code'
          ? `<pre><code>${escapeHtml(skipped.value ?? '')}</code></pre>`
          : `<p class="md-raw">${lines
              .slice(index, skipped.endLine)
              .map((l) => l.trim())
              .join(' ')}</p>`,
      );
      index = skipped.endLine - 1;
      continue;
    }
    if (/^\s*```/.test(line)) {
      if (inCodeFence) {
        out.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
        codeBuffer = [];
        inCodeFence = false;
      } else {
        flushAll();
        inCodeFence = true;
      }
      continue;
    }
    if (inCodeFence) {
      codeBuffer.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }

    /*
      A table: a row of cells, then an alignment row, then rows until one is
      not a row. Built from the escaped source like everything else, with the
      same inline pass on each cell and tags that carry no attributes — the
      alignment row is read for its shape and nothing else, so no user text
      reaches a style.
    */
    if (isTableRow(line) && isTableRule(lines[index + 1] ?? '')) {
      flushAll();
      const head = cells(line);
      const body: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        body.push(cells(lines[index] ?? ''));
        index += 1;
      }
      index -= 1;
      const row = (values: string[], tag: 'th' | 'td') =>
        `<tr>${head
          .map(
            (_, column) => `<${tag}>${inline(values[column] ?? '', tagLinks, mentions)}</${tag}>`,
          )
          .join('')}</tr>`;
      out.push(
        `<table><thead>${row(head, 'th')}</thead><tbody>${body
          .map((values) => row(values, 'td'))
          .join('')}</tbody></table>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushAll();
      // A blip already sits inside a page, so its "h1" renders as an h2.
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2], tagLinks, mentions)}</h${level}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    // The source has been escaped, so a blockquote marker arrives as &gt;.
    const quote = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      quoteBuffer.push(quote[1] ?? '');
      continue;
    }
    flushQuote();

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet ?? numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listType = wanted;
      }
      out.push(`<li>${inline(bullet?.[1] ?? numbered?.[1] ?? '', tagLinks, mentions)}</li>`);
      continue;
    }
    closeList();

    paragraph.push(line.trim());
  }

  if (inCodeFence && codeBuffer.length > 0) {
    out.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
  }
  flushAll();

  const html = out.join('\n');
  return drawn.length === 0
    ? html
    : html.replaceAll(/\uE000(\w+):(\d+)\uE001/g, (match, tag: string, index: string) =>
        tag === nonce ? (drawn[Number(index)] ?? '') : match,
      );
}

/** Plain-text preview for dense views, with markup stripped rather than rendered. */
export function plainText(source: string, max = 220): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    /*
      Tables, before anything else eats their shape.

      A markdown table stripped by the character class below arrives as pipe
      soup — `| | | |---|---| | bearing strip | 20px |` was a real search
      snippet on a blip whose measurements were in a table, and it is the least
      readable thing this function has ever produced. The alignment row carries
      no words at all, so it goes; the cell separators become the same middot
      the instrument voice already uses between facts.
    */
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/[ \t]*\|[ \t]*/g, ' · ')
    /*
      Heading markers only. Stripping every `#` turned `#reading` into
      "reading" wherever this text was shown — a thread dialog's title, a
      control's accessible name, a search snippet — and a tag without its `#`
      is just a word. A heading's hashes are followed by a space; a tag's is
      followed by its name.
    */
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/[>*_`~]/g, '')
    // Collapse the runs an empty cell leaves behind — ` ·  ·  · ` reads as a
    // rendering fault rather than as a table that had gaps in it.
    .replace(/(?:·\s*){2,}/g, '· ')
    .replace(/\s+/g, ' ')
    .replace(/^[·\s]+|[·\s]+$/g, '')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
