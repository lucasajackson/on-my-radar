/**
 * Runtime configuration for the client.
 *
 * The API base is read at boot from the document, not from `import.meta.env`.
 * That is deliberate: a Vite env var is substituted at build time, so
 * config-in-the-bundle means one build per environment and the artifact you
 * tested stops being the artifact you promote. Reading it at runtime keeps one
 * bundle correct everywhere.
 *
 * The default is the empty string — same-origin, root-relative paths, exactly
 * what this client did when the server that served it was the only API it could
 * talk to. A separately-hosted client sets `apiBase` to the API's origin and
 * nothing else about it changes.
 */
export interface ClientConfig {
  /** Absolute origin of the API, or '' for same-origin. Never a trailing slash. */
  apiBase: string;
}

/**
 * Read from a `<script type="application/json">` block rather than a global the
 * page assigns, because the app-wide CSP is `script-src 'self'` and an inline
 * script would be refused. A data block is never executed, so the policy does
 * not apply to it.
 *
 * Every failure here — no element, malformed JSON, a document that does not
 * exist because this ran under a test runner — lands on the same answer as an
 * absent config: same-origin. A client that cannot read its configuration
 * should behave like a client that was not given one, not fail to start.
 */
export function readConfig(doc: Pick<Document, 'getElementById'>): ClientConfig {
  try {
    const raw = doc.getElementById('omr-config')?.textContent;
    if (!raw) return { apiBase: '' };
    const parsed = JSON.parse(raw) as Partial<ClientConfig>;
    const base = typeof parsed.apiBase === 'string' ? parsed.apiBase.replace(/\/+$/, '') : '';
    return { apiBase: base };
  } catch {
    return { apiBase: '' };
  }
}

export const clientConfig: ClientConfig =
  typeof document === 'undefined' ? { apiBase: '' } : readConfig(document);

/** Prefixes an API path with the configured base. Paths always start with '/'. */
export function apiUrl(path: string): string {
  return `${clientConfig.apiBase}${path}`;
}
