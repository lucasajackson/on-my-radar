/**
 * Content-type rules shared by the upload path, the download path and the
 * email parser worker. Dependency-free on purpose: the parser runs in a worker
 * thread with a 64 MiB heap, and importing `storage.ts` there would load the
 * whole AWS SDK into every parse.
 */

/** Refused outright before a browser is handed a signed PUT. */
const REFUSED_UPLOAD_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/x-msdownload',
  'application/x-msdos-program',
]);

/** `type/subtype`, lowercased and without parameters; '' when there is none. */
export function mediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function isRefusedUploadType(contentType: string): boolean {
  return REFUSED_UPLOAD_TYPES.has(mediaType(contentType));
}

/**
 * Would a browser open this as a document that can run script?
 *
 * Wider than the upload refusal list, because the refusal list is a policy
 * about what people may upload and this is a fact about browsers: an XML
 * document whose root is in the XHTML namespace runs its `<script>`, and so does
 * one styled by an XSLT sheet. Every `+xml` type renders as XML. Objects stored
 * before a type was refused — or arriving by email, where a refusal would bounce
 * the whole message — still exist, so the download is where this is enforced.
 */
export function rendersActiveDocument(contentType: string): boolean {
  const type = mediaType(contentType);
  return (
    REFUSED_UPLOAD_TYPES.has(type) ||
    type === 'text/xml' ||
    type === 'application/xml' ||
    type === 'text/xsl' ||
    type.endsWith('+xml')
  );
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The type an email attachment is stored under.
 *
 * A sender's MIME header is not a promise of anything, and it arrives as part
 * of a message that is captured whole or not at all: refusing one `.html`
 * receipt or a malformed `Content-Type` used to bounce the entire email with a
 * generic SMTP rejection. Those parts are kept as opaque bytes instead, which a
 * browser only ever downloads.
 */
export function storableEmailContentType(contentType: string): string {
  const type = mediaType(contentType);
  return MEDIA_TYPE.test(type) && !rendersActiveDocument(type) ? type : 'application/octet-stream';
}
