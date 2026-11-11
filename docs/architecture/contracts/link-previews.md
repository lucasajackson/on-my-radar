# Contract: Linked websites (link previews)

Status: Draft · Version 1.0 · Owner (OMR side): M5 Blips and capture · Owner (other side): Linked websites (the page a captured link points at) · Provider ref verified against: `services/unfurl.ts` at `2c4905d`

## 1. Scope

After a blip with a URL commits, an `unfurl` outbox job fetches the page once and stores a title, description and `og:image` URL in `blips.preview`.

## 2. Auth

None. The fetch uses `publicRequest` without `httpsOnly`: plain HTTP and any port are allowed, userinfo is refused, `localhost`, `.local`, `.internal` and `.cluster.local` and every private, loopback, link-local, range is refused; NAT64 and 6to4 addresses are judged by their embedded IPv4 address, and `64:ff9b:1::/48` and Teredo are refused outright.

## 3. Operations

| Operation | Shape           | Effect | Notes                                                                                                                                                                                                              |
| --------- | --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fetch     | `GET <url>`     | read   | At most 3 redirects, each re-vetted; 6 second timeout, 512 KiB read; DNS lookup shares the 6 second per-hop deadline (the 3 second vetting timeout belongs to the save-time check used by subscriptions and feeds) |
| Store     | `blips.preview` | write  | Only where the blip's URL is unchanged; the image URL must be http or https                                                                                                                                        |

## 4. Errors and refusals

- A failure leaves the blip without a preview and never blocks capture.

## 5. Idempotency, versioning and limits

- An ordinary fetch failure is not retried: `unfurl` returns null, the handler returns, and the job completes with no preview. The job is retried only when it did not finish: a pod killed mid-fetch, or an exception escaping the handler such as a database error on the update. Retries use the outbox backoff.

## 6. Known gaps and unverified facts

- Older briefs call this the only outbound fetch of a user URL; it is one of five callers of the shared transport.
