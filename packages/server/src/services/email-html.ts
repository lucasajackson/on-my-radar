import sanitizeHtml from 'sanitize-html';
import { convert } from 'html-to-text';

const emailTags = [
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'a',
  'img',
  'center',
];
const color = /^(?:#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\))$/i;
const length = /^(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|em|rem|%))$/i;
const spacing = /^(?:(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))\s*){1,4}$/i;
function webUrl(value: string | undefined, image = false): string | null {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      !(image ? ['https:'] : ['https:', 'http:', 'mailto:']).includes(url.protocol)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function normalizeContentId(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

/**
 * The allow-list, shared by the ingest pass and the render pass. Rendering used to
 * pass `allowedAttributes: false`, trusting that stored HTML had been through
 * ingest; anything that reached storage another way (an older sanitizer, a
 * restored row, a bug) then rendered with its event handlers and unfiltered
 * `style` intact. Both passes now apply the same tags, attributes, styles and
 * non-text tags; only schemes and the `img` transform differ.
 */
export const emailSanitizeBase = {
  allowedTags: emailTags,
  allowedAttributes: {
    '*': ['style', 'dir'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'data-omr-image'],
    table: ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'role'],
    td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
    th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
    col: ['width', 'span'],
  },
  allowProtocolRelative: false,
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'noscript',
    'head',
    'title',
    'svg',
    'math',
  ],
  allowedStyles: {
    '*': {
      color: [color],
      'background-color': [color],
      'font-size': [length],
      'font-family': [/^[a-z\s,'"-]{1,128}$/i],
      'font-weight': [/^(?:normal|bold|[1-9]00)$/],
      'font-style': [/^(?:normal|italic|oblique)$/],
      'text-align': [/^(?:left|right|center|justify)$/],
      'text-decoration': [/^(?:none|underline|line-through)$/],
      'line-height': [/^(?:normal|[0-3](?:\.\d{1,2})?|\d{1,3}(?:px|%))$/],
      width: [length],
      'max-width': [length],
      height: [length],
      padding: [spacing],
      margin: [spacing],
      border: [/^\d{1,2}px (?:solid|dashed|dotted) (?:#[a-f\d]{3,8}|[a-z]{1,24})$/i],
      'border-collapse': [/^(?:collapse|separate)$/],
      'vertical-align': [/^(?:top|middle|bottom|baseline)$/],
    },
  },
} satisfies sanitizeHtml.IOptions;

/** PostCSS parses declarations; anchored property grammars exclude every URL/function except colors.
 * Style blocks and all author active content are discarded, not regular-expression-filtered. */
export function sanitizeEmailHtml(input: string): string {
  return sanitizeHtml(input, {
    ...emailSanitizeBase,
    allowedSchemes: ['https', 'http', 'mailto', 'cid'],
    allowedSchemesByTag: { img: ['cid'] },
    transformTags: {
      a: (_name, attrs) => {
        const href = webUrl(attrs['href']);
        return {
          tagName: 'a',
          attribs: {
            ...(href ? { href } : {}),
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
          },
        };
      },
      img: (_name, attrs) => {
        const src = attrs['src'] ?? '';
        const remote = webUrl(src, true);
        const cid = /^cid:/i.test(src) ? normalizeContentId(src.slice(4)) : '';
        return {
          tagName: 'img',
          attribs: {
            alt: attrs['alt']?.slice(0, 500) ?? '',
            ...(attrs['width'] ? { width: attrs['width'] } : {}),
            ...(attrs['height'] ? { height: attrs['height'] } : {}),
            ...(cid
              ? { src: `cid:${encodeURIComponent(cid)}` }
              : remote
                ? { 'data-omr-image': remote }
                : {}),
          },
        };
      },
    },
  });
}

/** Parsing preserves paragraph breaks and decoded entities without interpreting active content. */
export function emailHtmlText(input: string): string {
  return convert(input, {
    wordwrap: false,
    limits: { maxInputLength: 20 * 1024 * 1024, maxDepth: 40 },
    selectors: [{ selector: 'img', format: 'skip' }],
  }).trim();
}

/** Stored HTML has already passed the sanitizer. This second parse only resolves image references. */
export function renderEmailHtml(html: string, cidUrls: Map<string, string>, remote: boolean) {
  let remoteImagesBlocked = 0;
  const imageOrigins = new Set<string>();
  const rendered = sanitizeHtml(html, {
    ...emailSanitizeBase,
    // After the transform below an image `src` is a resolved download URL, so
    // `cid` is no longer a scheme that can appear here.
    allowedSchemes: ['https', 'http', 'mailto'],
    transformTags: {
      img: (_tag, attrs) => {
        let src: string | null = null;
        if (attrs['src']?.startsWith('cid:')) {
          try {
            src = cidUrls.get(decodeURIComponent(attrs['src'].slice(4))) ?? null;
          } catch {
            /* An invalid CID has no image. */
          }
        } else if (attrs['data-omr-image']) {
          if (remote) src = webUrl(attrs['data-omr-image'], true);
          else remoteImagesBlocked++;
        }
        delete attrs['src'];
        delete attrs['data-omr-image'];
        if (src) {
          attrs['src'] = src;
          imageOrigins.add(new URL(src).origin);
        }
        return { tagName: 'img', attribs: attrs };
      },
    },
  });
  return { html: rendered, remoteImagesBlocked, imageOrigins: [...imageOrigins] };
}

/** Only referenced raster resources disappear from the downloadable-file list. */
export function isInlineEmailImage(
  html: string | null,
  contentType: string,
  contentId: string | null,
): boolean {
  return Boolean(
    html &&
    contentId &&
    /^image\/(?:png|jpeg|gif|webp)$/i.test(contentType) &&
    html.includes(`src="cid:${encodeURIComponent(contentId)}"`),
  );
}
