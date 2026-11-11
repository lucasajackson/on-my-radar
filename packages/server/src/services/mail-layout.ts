/**
 * The one layout every On My Radar email is built from.
 *
 * The brand is the app's and the marketing site's: true-black surfaces,
 * hairline borders, paper-white text, light wide headings in Encode Sans
 * Expanded, and colour held back for the radar itself — warm for a person,
 * cobalt for an agent. The mark is the favicon's radar with one blip of each.
 *
 * Email is not the web, and each rule below is one a client enforces:
 *
 * - **Tables and inline styles.** Gmail drops `<style>` in several of its
 *   clients and Outlook lays out with Word, so structure is `<table>` and every
 *   colour is on the element that needs it.
 * - **Backgrounds twice**, as `bgcolor` and as `background-color`: some clients
 *   honour only one. No text ever sits on an image.
 * - **Dark, declared.** `color-scheme` / `supported-color-schemes` tell Apple
 *   Mail and iOS the design is already dark, so they leave it alone. A client
 *   that force-inverts anyway (Gmail's iOS app, Outlook's dark mode on some
 *   builds) turns paper-on-black into ink-on-white, which reads just as well —
 *   every pairing here is high contrast in both directions, and nothing relies
 *   on a colour surviving to carry meaning.
 * - **A PNG mark**, never SVG, which most clients block. Served by the app at
 *   a stable path (`/email-mark.png`), the image is decoration: its `alt` is
 *   the name, and the wordmark beside it is live text.
 * - **Bulletproof buttons**: a link padded and coloured inside a cell that is
 *   also coloured, so a client that drops either still shows a button.
 * - **Web fonts are a bonus.** The Google Fonts `<link>` works in Apple Mail
 *   and iOS; everywhere else the system stack below it takes over.
 *
 * Every template also carries a plain-text part, built alongside it in
 * `mail.ts`; nothing here changes what a message says.
 */
import { env } from '../env.js';

export const MAIL_COLORS = {
  page: '#000000',
  card: '#0a0a0a',
  panel: '#141414',
  border: '#262626',
  paper: '#f5f5f5',
  dim: '#a3a3a3',
  faint: '#737373',
  warm: '#ffb457',
  cobalt: '#60a5fa',
} as const;

const HEADING_FONT =
  "'Encode Sans Expanded', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const BODY_FONT =
  "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_FONT = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Encode+Sans+Expanded:wght@200;300&family=Geist:wght@400;500&family=Geist+Mono:wght@500&display=swap';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );
}

/** Where the mark is served, on the same host the person signs in at. */
export function markUrl(): string {
  return `${env().APP_URL}/email-mark.png`;
}

/* ------------------------------ building blocks --------------------------- */
/*
 * Each block takes plain text and escapes it, except where it says it takes
 * HTML — and those take only what another block here produced. That keeps the
 * rule from `docs/DESIGN.md` §11 true for mail as well: user text is escaped
 * once, at the edge, and nothing re-interprets it.
 */

export type MailBlock = string & { readonly __mailBlock: true };
const block = (html: string) => html as MailBlock;

/** A paragraph of body text. A `{ strong }` part is a name, set in paper-white. */
export function paragraph(
  parts: ReadonlyArray<string | { strong: string }>,
  options: { dim?: boolean; last?: boolean } = {},
): MailBlock {
  const inner = parts
    .map((part) =>
      typeof part === 'string'
        ? escapeHtml(part)
        : `<strong style="color:${MAIL_COLORS.paper};font-weight:500;">${escapeHtml(part.strong)}</strong>`,
    )
    .join('');
  return block(
    `<p style="margin:0 0 ${options.last ? 0 : 16}px;font-family:${BODY_FONT};font-size:15px;line-height:1.65;color:${options.dim ? MAIL_COLORS.dim : MAIL_COLORS.paper};">${inner}</p>`,
  );
}

/**
 * The call to action. Warm, because it is always the person's own next step;
 * black text on it holds contrast whether or not a client inverts it.
 */
export function button(
  href: string,
  label: string,
  options: { last?: boolean } = { last: true },
): MailBlock {
  const url = escapeHtml(href);
  return block(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 ${options.last === false ? 24 : 0}px;">
  <tr><td bgcolor="${MAIL_COLORS.warm}" style="background-color:${MAIL_COLORS.warm};border-radius:999px;">
    <a href="${url}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${BODY_FONT};font-size:15px;font-weight:500;line-height:1;color:#000000;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`);
}

/** Quoted user content — a blip excerpt — escaped and never rendered. */
export function quote(text: string): MailBlock {
  return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
  <tr><td bgcolor="${MAIL_COLORS.panel}" style="background-color:${MAIL_COLORS.panel};border:1px solid ${MAIL_COLORS.border};border-left:2px solid ${MAIL_COLORS.warm};border-radius:10px;padding:14px 16px;font-family:${BODY_FONT};font-size:14px;line-height:1.6;color:${MAIL_COLORS.paper};">${escapeHtml(text)}</td></tr>
</table>`);
}

/**
 * A sign-in code: large, monospace, and one run of digits with no spaces in
 * it, so selecting it copies exactly what has to be typed.
 */
export function codeBlock(code: string): MailBlock {
  return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
  <tr><td align="center" bgcolor="${MAIL_COLORS.panel}" style="background-color:${MAIL_COLORS.panel};border:1px solid ${MAIL_COLORS.border};border-radius:14px;padding:22px 12px;">
    <span style="font-family:${MONO_FONT};font-size:38px;font-weight:500;letter-spacing:.32em;line-height:1;color:${MAIL_COLORS.paper};">${escapeHtml(code)}</span>
  </td></tr>
</table>`);
}

/* --------------------------------- the frame ------------------------------- */

export interface LayoutInput {
  /** Plain text; shown large and light. */
  heading: string;
  /** The inbox preview line. Plain text. */
  preheader: string;
  blocks: readonly MailBlock[];
}

function mark(): string {
  const appUrl = escapeHtml(env().APP_URL);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td style="padding:0 12px 0 0;" valign="middle"><a href="${appUrl}" target="_blank"><img src="${escapeHtml(markUrl())}" width="36" height="36" alt="On My Radar" style="display:block;width:36px;height:36px;border:0;outline:none;text-decoration:none;"></a></td>
    <td valign="middle" style="font-family:${HEADING_FONT};font-size:15px;font-weight:300;letter-spacing:.04em;color:${MAIL_COLORS.paper};">On My Radar</td>
  </tr>
</table>`;
}

export function layout(input: LayoutInput): string {
  const c = MAIL_COLORS;
  const host = escapeHtml(new URL(env().APP_URL).host);
  const appUrl = escapeHtml(env().APP_URL);
  return `<!doctype html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.heading)}</title>
<link rel="stylesheet" href="${FONTS_HREF}">
</head>
<body bgcolor="${c.page}" style="margin:0;padding:0;background-color:${c.page};color:${c.paper};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${c.page};font-size:1px;line-height:1px;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background-color:${c.page};">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
    <tr><td style="padding:0 4px 20px;">${mark()}</td></tr>
    <tr><td bgcolor="${c.card}" style="background-color:${c.card};border:1px solid ${c.border};border-radius:18px;padding:36px 32px 32px;">
      <h1 style="margin:0 0 20px;font-family:${HEADING_FONT};font-size:26px;font-weight:300;line-height:1.25;letter-spacing:.01em;color:${c.paper};">${escapeHtml(input.heading)}</h1>
      ${input.blocks.join('\n      ')}
    </td></tr>
    <tr><td style="padding:20px 4px 0;font-family:${BODY_FONT};font-size:12px;line-height:1.6;color:${c.faint};">You are receiving this because someone entered this address at <a href="${appUrl}" target="_blank" style="color:${c.cobalt};text-decoration:none;">${host}</a>. If that was not you, you can ignore it safely.</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}
