import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Mail, Paperclip } from 'lucide-react';
import type { BlipDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { fileSize, fullTime, relativeTime } from '../lib/format';
import { Modal, Spinner } from './primitives';
import { QueryError } from './query-error';

/** An email stays a compact source card regardless of its radar's layout. */
export function EmailContent({
  blip,
  compact = false,
  publicSlug,
  previewText,
}: {
  blip: BlipDto;
  compact?: boolean;
  publicSlug?: string;
  previewText?: string;
}) {
  const [open, setOpen] = useState(false);
  const email = blip.email;
  if (!email) return null;
  const subject = blip.title || email.subject || 'Email without a subject';
  return (
    <>
      <div className={`email-card ${compact ? 'is-compact' : ''}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="instrument inline-flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            Email
          </span>
          <time
            className="note ml-auto"
            dateTime={email.receivedAt}
            title={fullTime(email.receivedAt)}
          >
            {relativeTime(email.receivedAt)}
          </time>
        </div>
        <button
          className="email-card-subject"
          onClick={() => setOpen(true)}
          aria-label={`Read email: ${subject}`}
        >
          {subject}
        </button>
        {email.senderName || email.senderAddress ? (
          <p className="note mt-1 truncate">From {email.senderName || email.senderAddress}</p>
        ) : null}
        <p className="email-card-preview">
          {previewText || email.preview || 'Open the email to read its message and attachments.'}
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="note inline-flex items-center gap-1.5">
            {email.attachmentCount ? (
              <>
                <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                {email.attachmentCount} {email.attachmentCount === 1 ? 'attachment' : 'attachments'}
              </>
            ) : null}
          </span>
          <button className="btn btn-ghost !px-2 !py-1 text-[12.5px]" onClick={() => setOpen(true)}>
            Read email <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
      {open ? (
        <EmailReader
          blip={blip}
          {...(publicSlug ? { publicSlug } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The server sanitizes message markup; this document adds an independent browser boundary. */
export function emailDocument(html: string, imageOrigins: string[], remoteImages: boolean): string {
  const origins = imageOrigins.flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  const imagePolicy =
    [...new Set(origins), ...(remoteImages ? ['https:'] : [])].join(' ') || "'none'";
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${imagePolicy}; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light;background:white;color:#202020}body{margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}table{max-width:100%!important}img{max-width:100%!important;height:auto!important}pre{white-space:pre-wrap}a{overflow-wrap:anywhere}</style></head><body>${html}</body></html>`;
}

function EmailReader({
  blip,
  publicSlug,
  onClose,
}: {
  blip: BlipDto;
  publicSlug?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<'message' | 'text'>('message');
  const [remoteImages, setRemoteImages] = useState(false);
  const tabId = useId();
  const query = useQuery({
    queryKey: ['email-message', publicSlug ?? 'private', blip.id, remoteImages],
    queryFn: () =>
      publicSlug
        ? api.publicRadars.email(publicSlug, blip.id, remoteImages)
        : api.blips.email(blip.id, remoteImages),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const email = query.data?.email;
  const subject = blip.title || blip.email?.subject || 'Email without a subject';
  const hasHtml = Boolean(email?.html);
  const selected = hasHtml ? view : 'text';
  return (
    <Modal
      title={subject}
      description="Received email"
      size="reader"
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close email
        </button>
      }
    >
      <div className="email-reader">
        {query.isPending ? (
          <Spinner label="Loading email" />
        ) : query.error ? (
          <QueryError resource="Email" error={query.error} retry={() => query.refetch()} />
        ) : email ? (
          <>
            <div className="email-reader-controls">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {email.senderName || email.senderAddress ? (
                  <p className="min-w-0 break-words text-[13px]">
                    From <strong>{email.senderName || email.senderAddress}</strong>
                  </p>
                ) : (
                  <span className="note">Received email</span>
                )}
                <time className="note" dateTime={email.sentAt || email.receivedAt}>
                  {fullTime(email.sentAt || email.receivedAt)}
                </time>
              </div>
              {email.subject && email.subject !== subject ? (
                <p className="note mt-1 break-words">Original subject: {email.subject}</p>
              ) : null}
              {email.senderAddress && email.senderName ? (
                <p className="note mt-1 break-all">{email.senderAddress}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label="Email view" className="flex gap-1">
                  {(['message', 'text'] as const).map((option) => (
                    <button
                      key={option}
                      role="tab"
                      id={`${tabId}-${option}`}
                      aria-controls={`${tabId}-panel`}
                      aria-selected={selected === option}
                      tabIndex={selected === option ? 0 : -1}
                      disabled={option === 'message' && !hasHtml}
                      className={`btn ${selected === option ? 'btn-accent' : 'btn-ghost'}`}
                      onClick={() => setView(option)}
                      onKeyDown={(event) => {
                        if (
                          !hasHtml ||
                          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? 'message'
                            : event.key === 'End'
                              ? 'text'
                              : selected === 'message'
                                ? 'text'
                                : 'message';
                        setView(next);
                        document.getElementById(`${tabId}-${next}`)?.focus();
                      }}
                    >
                      {option === 'message' ? 'Message' : 'Text'}
                    </button>
                  ))}
                </div>
                {email.originalHref ? (
                  <a
                    className="btn btn-ghost ml-auto"
                    href={email.originalHref}
                    download
                    rel="noreferrer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Original email
                  </a>
                ) : null}
              </div>
              {!hasHtml ? (
                <p className="note mt-2">
                  {email.legacy
                    ? 'This earlier capture contains text only. Its original layout was not saved.'
                    : 'This email has no formatted version.'}
                </p>
              ) : null}
              {email.remoteImagesBlocked > 0 && !remoteImages && selected === 'message' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="note min-w-0 flex-1">
                    Remote images are hidden. Loading them may tell the sender you opened this
                    email.
                  </p>
                  <button className="btn" onClick={() => setRemoteImages(true)}>
                    Load remote images
                  </button>
                </div>
              ) : null}
              {remoteImages ? (
                <p className="note mt-2">Remote images allowed for this view.</p>
              ) : null}
            </div>
            <div
              className="email-reader-pane"
              role="tabpanel"
              id={`${tabId}-panel`}
              aria-labelledby={`${tabId}-${selected}`}
            >
              {selected === 'message' && email.html ? (
                <iframe
                  title={`Email message: ${subject}`}
                  srcDoc={emailDocument(email.html, email.imageOrigins, remoteImages)}
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  referrerPolicy="no-referrer"
                  tabIndex={0}
                />
              ) : (
                <div className="email-reader-text">
                  {email.text || 'This email has no text content.'}
                </div>
              )}
            </div>
            {email.attachments.length || email.notes ? (
              <div className="email-reader-files">
                {email.attachments.length ? (
                  <details>
                    <summary className="cursor-pointer text-[13px] font-medium">
                      Attachments ({email.attachments.length})
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1">
                      {email.attachments.map((file) => (
                        <li key={file.id}>
                          <a
                            href={`${file.href}${file.href.includes('?') ? '&' : '?'}download=1`}
                            className="flex items-center gap-2 rounded px-2 py-2 text-[13px] hover:bg-[color:var(--ink-750)]"
                          >
                            <Paperclip className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1 break-all">{file.filename}</span>
                            <span className="note shrink-0">{fileSize(file.size)}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {email.notes ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[13px] font-medium">
                      Notes on this blip
                    </summary>
                    <p className="note mt-2 whitespace-pre-wrap break-words">{email.notes}</p>
                  </details>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
