# Feed capture, email capture and live dashboards

## Agreed implementation plan — 19 September 2026

The web app gains three connected capabilities: external sources that capture
ordinary blips, and dashboards that compose those blips without copying them.
The existing service-layer authorization, outbox, R2 attachment storage, search
parser and UI primitives remain the shared implementation paths.

- Protect the personal Drop box from deletion at the service boundary and hide
  its delete action. It remains the permanent default capture destination.
- Add RSS/Atom subscriptions under radar **Sources**. Ask explicitly how far back
  to import: forever, past year, month, week or day. The initial cutoff stays
  fixed; future entries continue to import. Forever means history exposed by the
  feed, not an archive the publisher no longer serves.
- Poll with conditional requests, bounded response size, timeouts, backoff and
  worker leases. Reject private-network destinations and unsafe XML. Deduplicate
  by compact stable entry hashes atomically with capture; never retain a second
  copy of feed bodies as an import ledger. Pause/removal preserves captured blips.
- Give each account a unique email alias: `username@onmyradar.io` captures to its
  Drop box; `username+radar-slug@onmyradar.io` captures to an owned radar. Each
  radar accepts only individually approved, authenticated senders, beginning
  with its owner's account email. There is no wildcard or accept-all setting.
- Authenticate the inbound provider boundary and the original sender; treat
  email as content capture, not a mailbox. Store permitted attachments in the
  existing R2 bucket, enforce size/rate limits and prevent delivery retries from
  creating duplicate blips. Rejected mail must not create persistent attachments.
- Verify notification submission and delivery through Resend using a controlled
  test addressed to the requesting user's account.
- Add named **Live query** dashboard widgets beside radar widgets. Reuse the
  existing search language (`in:`, `tag:`, `is:`, `after:7d`, ordinary words),
  preview interpretations and errors before saving, and resolve current access
  at every execution. Widget results are live queries, not materialized copies.
- Preserve widget configuration and IDs when rearranging; provide edit/remove
  controls on mobile as well as desktop. Keep loading, failure and empty states
  distinct, and retain the neutral application shell across themed radars.

## Delivery and verification

Implementation is split by ownership: RSS/Drop box and shared capture transaction,
email/provider integration, dashboard service/contracts, and UI design/build.
Database migrations are additive and numbered independently. Source review and
real PostgreSQL regression tests cover authorization, replay/concurrency,
deduplication and failure recovery. Browser QA covers the complete settings and
widget journeys at phone and desktop sizes. Provider routing and DNS are enabled
only after the receiving code and secrets are ready. The normal serialized CI
release publishes verified images and performs production smoke checks.

Implementation details and final verification evidence follow below.

## RSS subscriptions and the permanent Drop Box

The Drop Box cannot be deleted through the radar service or its HTTP endpoint.
Ordinary radar deletion continues to remove the radar and its attachments.

An owner can add RSS 2.0 or Atom sources to any standard radar, including the
Drop Box. The web Sources panel uses `/api/radars/:id/feeds` and its `/:feedId`
child for list/create/update/remove. This release exposes source settings on the
web; it does not add agent configuration tools. Feed capture still goes through
`createBlip`, the same authorization, inference, attachment, and outbox path as
normal capture.

History choices are forever, year (365 days), month (30 days), week, and day.
The selected cutoff is recorded when the subscription is created or changed; it
is not moved forward each time the worker polls. Forever means every entry the
publisher currently exposes, including undated entries. A finite window imports
only entries with a valid publication/update date in that window. The application
cannot recover articles a publisher no longer supplies. It does not crawl linked
articles, download enclosures, or promise feed archives that are absent from the
source. Imported text carries a feed URL and available publication date so the
origin remains visible to readers and agents. Imports obey normal radar notification
preferences and do not self-notify the owner by default, avoiding a burst of email
for historical backfills.

Polling is worker-owned, normally every 15 minutes with ETag/Last-Modified
conditional requests. Each source has a database lease, exponential failure
backoff, and a visible last error. One poll captures at most 500 entries and stops starting additional captures after
20 seconds of capture work. An individual database operation may finish after that
budget. If more entries remain, the worker revisits the source
after 30 seconds without conditional validators; completed hashes are skipped.
Validators are saved only after all currently available matching entries have
been considered. This preserves continuation instead of silently dropping the
501st entry. A changed live feed can only supply the history it still retains.

At most 10 active sources per radar and 50 per account are permitted, with
account locking to enforce limits under concurrent requests. The worker runs separate single-concurrency loops for delivery/housekeeping and
feed polling, so a slow feed cannot hold up queued notifications. Both loops are
joined during shutdown. Polling pauses when at least
1,000 outbox jobs are due, allowing notifications and other delivery work to
catch up. Paused, removed, suspended-account, and archived-radar sources cannot
capture; state is checked again inside each capture transaction. Configuration
revisions prevent a poll already in progress from overwriting newer settings.

Feed fetches use the existing DNS-pinned public HTTP transport at every redirect,
with three redirects, a 20-second total fetch deadline, and a 2 MiB document cap.
Oversized documents and unsupported compressed responses produce a visible error.
The strict XML parser accepts at most 48 nesting levels and 20,000 entries per
document; DTDs and custom entities are rejected. The parser's upstream documents
its strict well-formedness and lack of automatic custom entity expansion:
[saxes documentation](https://github.com/lddubeau/saxes#regarding-doctype-and-entity).

Deduplication stores one compact SHA-256 identity hash per source/article, keyed
by GUID/Atom ID, then canonical article URL, then stable content identity. It
stores no title, body, attachment bytes, or second blip payload. The marker and
blip, including notification/outbox intent, commit in the same transaction.
Markers survive deleting the captured blip. Removing a subscription hides and
pauses its source record; re-adding that URL restores its marker set, so old or
deleted articles do not reappear. Deleting the radar cascades both source records
and markers. The small hash/index cost is deliberate: bounded-time dedupe caches
would forget old items and import duplicates again when an unchanged feed returns.

Regression coverage uses real PostgreSQL for concurrent polling, capture rollback,
removal/re-addition, deleted-blip tombstones, concurrent source quotas, cached
responses, lookback widening and a 504-entry continuation. Additional tests cover
XML/entity/size/depth rejection, private redirect refusal, pause/suspension/archive
races, removal racing an update, queue backpressure, and Drop Box HTTP refusal.

## Web experience

Radar settings now group RSS imports and incoming email under Sources; Webhooks
retains its existing tab. Sources is available to owners of standard radars,
including Drop box. Feed creation requires an explicit history selection. The
form explains that feed providers may supply only a recent archive and that
finite windows skip undated entries. Failed saves preserve the URL/history draft.
Rows show queued, active, paused and failed checks, imported count, pause/resume
and removal that keeps imported blips.

Account Settings reserves the permanent email username, with the permanence
explained before saving. Each radar has its own receive switch and exact approved
sender list. The account address is visibly always approved and cannot be
removed. Service configuration and a reserved address are distinct states; the UI
never claims mail delivery is working before the service reports availability.
Backend-issued addresses survive radar renaming. Clipboard feedback follows the
actual write result.

Add widget offers Radar and Live query. Live queries reuse Search's completion,
examples and interpreted-filter presentation. A debounced preview must resolve
successfully before save; a valid empty result may be saved. Query cards show
source radars, Edit query and Open full results, refreshing once a minute while
the page is visible. Up to twelve live query widgets may occupy a dashboard.
Layout updates preserve saved widget IDs and typed query configuration; new
widgets receive authoritative server IDs after save. Failed saves roll back the
layout while preserving the editor draft.

Arrange widget provides position and size fields and Move up/Move down controls
on desktop and mobile. Drag and corner resize remain optional desktop shortcuts.
Collision resolution moves obstructing widgets aside instead of hiding cards
under each other, and new widgets fill available grid space. Interrupted pointer
drags do not save. Drop box settings explain its permanent role and omit Delete.

Frontend regression coverage includes required history choice with failed-save
draft retention, persisted query/identity preservation, collision displacement,
new-card placement, geometry limits, a full-canvas failure, and valid-empty versus unresolved query preview saving. The complete UI
suite passed 94 tests and production build/typecheck passed; browser journey
verification is recorded by the integration pass.

Backend verification on PostgreSQL 16.15: **725 tests passed across 57 files**,
including all 15 RSS/parser/Drop Box regressions. Server typecheck and full server
lint passed with zero warnings. A fresh database applied all **20 migrations**;
the second migration run applied zero and skipped all 20. Provider delivery and
browser results are recorded separately below by their owning workstreams.

## Email capture implementation and activation

Each person claims one permanent, unique lowercase username. Their Drop Box uses
`username@onmyradar.io`; other owned radars persist the initial readable radar
slug as `username+slug@onmyradar.io`. Renaming a radar does not change its address.
Aliases are unique per owner, at most 31 characters; collisions get a short suffix.
Account username changes are refused so an old address cannot be reassigned while
mail senders still rely on it. Account deletion releases the username.

The first username claim creates the private Drop Box if necessary and enables
its bare-address email source in the same transaction, accepting only the account
email by default. Repeating a claim does not re-enable a source the owner disabled.
Migration `0024_initialize_email_drop_boxes.sql` repairs existing usernames whose
Drop Box or source row is missing; existing settings, including explicit opt-outs
and sender lists, are preserved. Reserving a username therefore produces a working
receiving configuration without a second, hidden activation step.

Sources settings enable capture and list individual approved sender addresses.
The owner's current sign-in address always remains allowed. There are no wildcard,
domain-wide, shared-editor, or agent-controlled settings. Admin status does not
configure someone else's address. Enabling a source requires claiming a username.

Cloudflare's email-only Worker streams raw MIME to the Kubernetes API. A small
metadata HMAC authenticates the recipient, declared size, timestamp and nonce;
TLS protects the stream. The relay has no MIME dependencies, R2 binding, Node
compatibility flag or paid CPU override. It accepts or permanently refuses mail
only when the API returns an explicit application verdict, preventing proxy/WAF
responses from being mistaken for a capture result.

The API authenticates before buffering. It admits at most two in-flight ingests
per process, with no queue, and applies a 20-second read/parse/storage budget. MIME
parsing and DKIM run in isolated Node worker threads with a 64 MiB V8 heap limit;
raw/attachment buffers are separately bounded by the message-size cap. The main
web event loop remains available while verification runs.

Verification failures now carry a bounded reason code through the parser thread
and into an operational log containing only that code and the request ID. Missing
or invalid signatures, mismatched signing domains, unsigned required headers,
ambiguous headers, parser limits and temporary DNS failures are distinguishable
without logging message bodies or header values. The source displays a fixed,
actionable explanation. These diagnostics do not weaken authentication: a sender
allowlist or SPF pass alone does not satisfy the current DKIM requirement.

The server independently verifies exact-domain-aligned DKIM using mailauth. It
never trusts Authentication-Results headers. It refuses duplicate interpretation
headers, unsigned present MIME interpretation headers/Subject, partial-body
signatures, expired signatures and non-SHA256 algorithms. Native Node needs no
workerd digest-alias patch. Temporary DNS failures remain transient. Permanent
authentication failures produce an SMTP rejection and a fixed source diagnostic
where the recipient exists.

Replay protection: a valid signature proves the sender signed the message, not
that they signed it for this capture address. A message is accepted when either
(a) the capture address (the relay's `X-OMR-Recipient`) is in a `To` or `Cc`
header the passing signature covered — the bottom-most instance, per RFC 6376
section 5.4.2, so an unsigned `To`/`Cc` added above it counts for nothing — or
(b) the passing, domain-aligned signature is fresh: its own `t=` is at most 2
hours old and not more than 5 minutes ahead of our clock, and its `x=`, if
present, has not passed (`FRESH_SIGNATURE_MAX_AGE_MS`,
`FRESH_SIGNATURE_CLOCK_SKEW_MS`). Rule (b) keeps Bcc, mailing lists and
server-side forwards working. A signature with no `t=` is never fresh, and the
unsigned `Date` header is never consulted. An old message signed for somebody
else and re-delivered here is refused with `stale_signature_for_other_recipient`;
it can still be replayed for up to two hours after it was sent, which is the
accepted trade for Bcc support. Note that within that window an unsigned `To`
added above the signed one is accepted too, by rule (b) and not because of the
added header.

Compatibility limitation: the required signature coverage is stricter than basic
DKIM verification. A provider may produce a valid aligned signature while leaving
one of the required MIME headers unsigned; that message is currently refused.
Enabling DKIM on a sender domain therefore still needs a real delivery check.
Relaxing coverage requires an explicit review of how unsigned interpretation
headers could change the captured content; this release does not change that policy.

Both relay and API cap a whole email at 10 MiB. The server permits at most twelve
attachments, eight DKIM signatures and 1,000 parsed headers, with a 64 KiB
header block and MIME nesting depth capped at 30. A radar admits at
most 100 new emails per day through one atomic database counter. The subject becomes
the initial blip title; original extracted plaintext remains searchable blip content,
capped at 100,000 characters. Full text and sanitized formatted content are preserved
separately for the reader, as described below. Permitted attachments pass through the
bounded Kubernetes ingest and into the existing R2 bucket after authorization;
finalization verifies their metadata through the normal capture path.

A SHA-256 identity over recipient and verified DKIM signature deduplicates retries,
including changes to unsigned delivery headers. The receipt claim and normal
blip/notification/outbox writes commit together. User/radar/source locks recheck
active account, ownership, archive state, source enablement and approved sender
after storage checks. Completed receipts discard content and file metadata
immediately and expire after 90 days; abandoned payloads expire after 24 hours,
with R2 deletion queued transactionally in batches of 500 receipts. Radar deletion
also includes pending email objects in its normal cleanup job.

Operational activation follows API and relay deployment. The existing R2 bucket
and outgoing Resend configuration are reused. Root-domain Email Routing points
all capture addresses to the relay, with plus-address support enabled. Resend's
`send.onmyradar.io` MX/SPF and DKIM records stay intact. The owner chose Kubernetes
processing after the original edge implementation exceeded the Workers Free CPU
allowance. `EMAIL_CAPTURE_ENABLED` stays false until API, relay and routing are
ready. See [the relay deployment guide](../packages/email-worker/README.md).

Outgoing mail was tested separately through the deployed production
`sendMail(notificationMessage(...))` path. Resend accepted the authorized test and
the exact subject **On My Radar notification delivery test** was confirmed in the
user's mailbox on 19 September 2026 at 06:36 EDT. This verifies acceptance and
actual inbox delivery, not merely the presence of a sending credential.

First-use email regression: a reserved username can enable a radar before its
alias exists. The UI gates on `identityConfigured`; the first successful update
allocates the address. Standard radar widget entries also link directly to their
blips, with keyboard focus and the same detail navigation as live query results.

## Dashboard query contract

A live query uses the same language as Search, with autocomplete and a preview;
it does not introduce another parser. For example:

```text
in:"Work" in:"Reading" is:inbox
in:"Release watch" after:7d
tag:reading has:attachment
```

Repeated `in:` filters combine radars; different filters narrow the results.
Dates apply to when a blip was captured, including feed imports. Results refresh
while the dashboard is visible, and **Open full results** opens the same query
in Search. Empty results are valid, but unresolved radar names and invalid
filters must be corrected before saving.

The API provides `POST /api/dashboards/preview` and
`GET /api/dashboards/:id/widgets/:widgetId/results`, also under `/api/v1`.
Every execution checks the dashboard owner and current readable radar set, so
revoking access removes results without rewriting saved queries. Layouts retain
widget IDs, are replaced transactionally under a dashboard row lock, and reject
foreign or duplicate widget IDs. A tab permits 60 widgets, including at most
12 live queries, with at most 50 results per query. Migration 0023 preserves old
radar widgets and normalizes their formerly unused configuration.

## Integration QA evidence

Manual Chrome checks used a separate local PostgreSQL database, never the user's
production radars. A real GitHub Atom feed imported ten entries; polling it again
left the total unchanged at eleven blips including the welcome blip. Desktop
checks covered required history selection, source status, username reservation,
first radar email activation, individual sender approval, live-query preview and
save, layout resizing, and opening a blip from a standard radar widget. Sources
and dashboard layouts were also inspected at 390 × 844.

The production Resend delivery check is recorded above. Inbound capture is live;
its separate SMTP, attachment and sender-rejection evidence is recorded below.

The initial feature-release workspace suite passed **826 tests** (725 server, 94 UI, seven email
authentication), with the workerd signature smoke passing separately. Typecheck,
lint, formatting, release-script tests, and the Alpine Docker build passed. The
production dependency audit reports no known vulnerabilities. The standalone
Wrangler and workerd development tools are excluded from the production API image.
MIME and signature libraries now ship with the Kubernetes server.

The final built-app browser suite passed **399/399 assertions** at 390px and
1024/1366/1440/1920px, including explicit RSS history selection, all five history
windows, Drop box deletion absence, mobile live-query saving and accessible
arrangement controls. Existing settings navigation assertions now require the
named sections, including Sources, instead of assuming a fixed four-tab count.
Browser QA also confirmed first-use email enabling and individually approved
sender updates, plus keyboard links from ordinary dashboard entries to blips.

The responsive browser suite passed **399/399 assertions**, covering 390-pixel
phone layout, 1024/1366/1440/1920-pixel desktop layout, navigation, themes,
Sources/history selection, the protected Drop box, and live-query widget creation
and arrangement. The original workerd signature test also passed in a clean
linux/amd64 Node 22 Bookworm Slim container matching the CI verification image.

CI exposed a sidebar data-loading race after the initial local browser pass. The
sidebar now reports loading and retry states, and a deterministic regression
holds its API responses until after a filter is entered. The final 399 assertions
include that ordering and verify the original exact filtering results.

### Kubernetes receiver verification

The revised receiver passes **843 workspace tests**: 743 server tests against
isolated PostgreSQL, 94 UI tests, and six relay tests. Typechecking, lint,
formatting and the production dependency audit pass. The relay's actual workerd
harness streams a 5 MiB message with bounded outstanding data and verifies
metadata signing plus explicit application response markers.

The compiled production server package also verified a 9.6 MiB signed MIME
message with a 7 MiB attachment inside Node 22 Alpine. Two concurrent copies
passed with the production pod's 0.5 CPU / 512 MiB limits in 2.3 seconds, with
approximately 269 MiB maximum process RSS. This exercises the packaged worker
thread entrypoint and native DKIM dependencies, not just a mocked parser.

### Production activation, 19 September 2026

The Kubernetes receiver was released as `be2d8ef` through green pipelines
4899/4900. Infrastructure commit `1510b954` enabled capture through Fleet.
Cloudflare root MX records, catch-all routing and plus-address support are active;
Resend's existing MX/SPF/DKIM records were preserved. The final email relay version
is `1f40b472-cb80-41c4-bb8d-6937a68f3c5f`.

Live SMTP checks used a dedicated temporary account. Bare-username mail reached
its Drop Box; a plus-address reached its separate radar. Small and 7 MiB
attachments were downloaded from private R2 and matched their original SHA-256
hashes. Completed receipts discarded their body/file metadata. Replaying a
completed receipt through the internal finalizer left the blip count unchanged;
this is an idempotency check, not a claim that a duplicate SMTP delivery was
injected. Removing the exact approved sender caused an explicit refusal with no
capture. One initially failed SMTP message later retried and was captured,
confirmed by both relay metadata and the database receipt.

The live check found two edge-runtime issues that local mocks had missed.
Cloudflare fetch accepts `manual`/`follow` redirects, so the relay now uses
`manual` and treats any redirect as an operational failure. The runtime harness
now sends the actual relay stream through native workerd fetch to a local
receiver and verifies a separate 307 is never followed. A JavaScript per-chunk
counter consumed 179 ms CPU on the large message; removing that redundant loop
reduced the same-size native-stream relay to **1 ms CPU**. Kubernetes independently
checks the signed length and size cap. The successful large event contained
10,049,442 raw bytes and took 5,019 ms wall time, including API/storage work.

Chrome verification confirmed the live Sources controls and attachment limits.
The user's permanent username and radars were not changed. All test identities,
radars, blips and R2 objects are removed after verification; no account-wide
approved-sender exception or wildcard was introduced.

### Original email reader and notes

New email captures retain a blip-owned `blip_emails` summary and two private R2
objects: a bounded JSON payload containing full extracted plaintext, sanitized
HTML and attachment/CID mappings, and the original MIME message. The MIME object
is at most 10 MiB; the JSON payload is at most 32 MiB to accommodate decoded text
and JSON escaping. Metadata is recorded on the pending receipt before any upload;
finalization verifies objects and atomically creates the summary with the blip.
Completed receipts discard this metadata immediately. No second full message copy
lives in Postgres.

Lists hydrate summaries in one query for the whole page, with no R2 reads. Email
cards show subject, sender, a short preview and downloadable attachment count.
The immutable original text remains `blips.body`; separate `emailNotes` edits
are limited to 10,000 characters and indexed alongside that body. Attempts to
replace an email body, or add email notes to an ordinary blip, are rejected by the
shared service used by REST and MCP. The title remains an editable label while the
original subject stays immutable.

The reader API is `GET /api[/v1]/blips/:id/email`; public readers use
`GET /api/public/radars/:slug/blips/:id/email`. Both check current radar access;
public reads require the exact public slug and a live blip. Responses are no-store.
The public response removes the sender address and the original download link.
`GET /api[/v1]/blips/:id/email/original` requires current membership and issues a
short-lived attachment-only MIME download. Original headers and recipient/envelope
addresses are never part of reader DTOs. Text inside a published message remains
published content, including any addresses the sender put in that text.

Formatting uses a maintained HTML parser/sanitizer with an explicit tag and inline
CSS property/value allowlist. Scripts, forms, SVG, frames, style blocks, CSS URL
functions and external resource attributes are removed. Tables and safe inline
fonts, colors, spacing and borders survive. The UI renders the safe fragment in a
sandboxed iframe under a restrictive CSP. CID images resolve only to raster image
attachments belonging to that exact blip in its current radar; inline logos do not
count as downloadable files. Remote HTTPS images are blocked until the reader
explicitly requests `?images=1`. They then load directly from the sender's image
host, not through an API proxy. Consent can disclose the reader's IP and image
request to that host; no mail image request is made by the server.

Reader admission is limited to two concurrent payload reads per API process;
excess requests receive a retryable 503 without a waiting queue. R2 reads have a
10-second budget and independently count bytes. HTML image resolution runs in a
disposable worker with a 10-second limit and 64 MiB old/16 MiB young heap budgets.
This keeps large newsletter parsing off the API event loop.

Moves retain the original metadata and object keys while current permissions
follow the blip. Blip/radar deletion snapshots payload, MIME and attachment keys
before cascade and queues durable object cleanup. Pending receipt expiration also
includes payload and MIME keys. A late upload after radar deletion or deletion of
an already captured blip is reconciled after the PUT settles.

Migration0025 recognizes older email captures only when a retained completed
receipt proves their provenance. Those cards honestly expose plain text with
`legacy:true`; HTML, CID metadata and original MIME were not stored and cannot be
reconstructed. Captures whose 90-day receipt already expired cannot be safely
identified automatically. Stylesheet-heavy email may look simpler because author
style blocks are intentionally removed; the original download preserves the source.
