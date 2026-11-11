# Outbound webhooks

A radar owner can open **Settings → Webhooks → Outbound webhooks**, register a
public HTTPS receiver, choose events and save the signing secret shown once.
Inbound webhooks remain a separate section on the same page. Smart radars are
queries, so subscribe to their underlying radars instead. Up to 20 subscriptions
may be configured per radar.

The receiver gets `blip.created`, `blip.updated`, `blip.deleted` and
`comment.created`. A lane move is one update, including any resulting triage-state
change. `changes` contains `{ from, to }` for fields whose values actually changed;
re-saving unchanged content produces no update event. Superseding a blip also
emits the lane/state update for the replaced blip. Moving between radars emits
`blip.deleted` to the source and `blip.created` to the destination, keeping the
source's previous content out of the destination's payload.

## Payload and verification

```json
{
  "id": "evt_8ce35055-d355-4e85-9c77-b2dc95d651c5",
  "event": "blip.updated",
  "occurredAt": "2026-09-20T14:03:11.204Z",
  "radar": { "id": "radar-uuid", "name": "Workshop Jobs" },
  "actor": { "kind": "agent", "id": "human-uuid", "name": "Lucas", "agentId": "agent-uuid" },
  "blip": {
    "id": "blip-uuid",
    "radarId": "radar-uuid",
    "kind": "task",
    "state": "active",
    "status": "doing",
    "title": "Print order",
    "body": "Prepare the order",
    "emailNotes": null,
    "tags": [],
    "url": null,
    "dueAt": null,
    "pinned": false,
    "supersedesId": null,
    "createdAt": "2026-09-18T15:22:03.000Z",
    "updatedAt": "2026-09-20T14:03:11.204Z"
  },
  "changes": {
    "status": { "from": "todo", "to": "doing" },
    "state": { "from": "inbox", "to": "active" }
  },
  "comment": null
}
```

`comment.created` adds the comment's id, blipId, body, parentId, visibility,
createdAt and updatedAt. `changes` is null except on updates.

`visibility` is `internal` on every radar but a Helpdesk. There it may also be
`client_pending` (a reply to the client waiting for the owner's review) or
`client` (released). The body is sent whatever the visibility, because a
subscription is the owner's own pipe: a receiver that forwards anything to a
client must filter on `visibility === 'client'` itself, and the W&W client
portal is never a subscription receiver (`docs/HELPDESK.md` §5.4, §7.5). A
release later is not an event here: a reply created as `client_pending` is not
re-sent when it is released. The portal's own events (slice 4) carry releases.

A blip snapshot carries the blip's **whole** body, untruncated, plus its
`emailNotes`. That is deliberate: a blip captured from a forwarded email holds
the message's readable text in `body`, and a receiver that got a truncated copy
would be storing a silently incomplete record of the thing it is mirroring. A
ceiling was considered and rejected for exactly that reason.

The consequence is worth stating plainly. Stored email artefacts are still never
included — no original `.eml`, no sanitized HTML document, no attachment bytes —
but the forwarded message's text does reach the receiver, so subscribe a radar
that receives email only to a receiver you would trust with that mail. An edit
that rewrites a large body also puts its previous value in `changes`, so a
single `blip.updated` can be a few hundred kilobytes. A test delivery uses `subscription.test`, with null blip,
changes and comment. It bypasses the event allowlist.

The HTTP request has these headers:

- `Content-Type: application/json`
- `X-OMR-Event-Id`: the event id, stable on every retry
- `X-OMR-Delivery-Attempt`: the one-based attempt number
- `X-OMR-Signature: t=<unix-seconds>,v1=<hex-hmac>`

Verify HMAC-SHA256 of `${timestamp}.${rawBody}` using the **entire** secret,
including its `omr_whsec_` prefix. Compare signatures in constant time and reject
timestamps more than 300 seconds in the past or future. Verify before parsing
JSON. See `verifySubscription` in
`packages/server/src/services/subscription-signing.ts` for a fail-closed Node
reference implementation. Never accept an unsigned request.

Persist the event id with your processing transaction to deduplicate. An event
can arrive more than once and delivery order is not guaranteed. Use `occurredAt`
and the blip's post-change `updatedAt` to discard stale updates. Use
`actor.agentId` to suppress echoes from your integration's own writes. Return 2xx
only after accepting the event durably.

## Delivery and access

An event is committed in the same Postgres transaction as the content change.
The existing worker runs an independent subscription delivery loop; slow receivers
do not occupy its notification/feed loops. API writes also kick due deliveries
as a latency optimization. **Run the worker for retry and restart recovery.**

Every network attempt rechecks that the creator is active and has write access
through the ordinary radar authorization service. Revocation, suspension and
pause stop delivery. Queued non-deletion events for a blip moved elsewhere are
suppressed. Deleting a subscription or radar cascades to its queue and history.
A request already in flight cannot be recalled by deletion, pause or rotation.

All public HTTPS destinations are resolved and validated on every attempt, then
the connection is pinned to a validated IP. Internal/private addresses are
refused. Redirects are failures, never followed. The entire request, including
DNS, has a ten-second deadline; response bodies are not read.

Any non-2xx or network failure retries after 1 minute, 5 minutes, 30 minutes,
2 hours and 3 hours (six total attempts over about 5h36m). Exhausting an event's
six attempts pauses the subscription, discards its remaining pending events and
creates an in-app notification for its creator. Repair the receiver, resume the
subscription and reconcile missed events. The last 100 completed attempts per
subscription are retained, with status, error, time, event id and attempt number;
response bodies and signing credentials are absent. A process crash can leave an
unrecorded attempt; its lease expires after one minute and the event is retried.

Secrets are random 256-bit values encrypted at rest with AES-256-GCM. The key is
HKDF-derived from `SESSION_SECRET` with an outbound-webhook-specific context.
API and worker must use the same session secret. Back it up separately from the
database; replacing it requires rotating/recreating outbound secrets. Subscription
secret rotation changes the key used for pending retries as well as new events.
Create and rotate responses show the new secret once; list/history never do.

## REST and MCP

All routes use the existing authenticated `/api` surface and require radar manage
access. Create, pause/resume, rotate and test also require a human session;
PAT/OAuth agent credentials cannot perform those actions.

| Method | Path                                                       | Body / result                                             |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/radars/:id/subscriptions`                            | `{ subscriptions: [...] }`                                |
| POST   | `/api/radars/:id/subscriptions`                            | `{ name, url, events }` → `{ subscription }`, secret once |
| PATCH  | `/api/radars/:id/subscriptions/:subscriptionId`            | `{ enabled: boolean }`                                    |
| DELETE | `/api/radars/:id/subscriptions/:subscriptionId`            | 204                                                       |
| POST   | `/api/radars/:id/subscriptions/:subscriptionId/rotate`     | `{ subscription }`, new secret once                       |
| POST   | `/api/radars/:id/subscriptions/:subscriptionId/test`       | 202, `{ queued: true }`                                   |
| GET    | `/api/radars/:id/subscriptions/:subscriptionId/deliveries` | `{ deliveries: [...] }`, newest first                     |

MCP exposes `list_subscriptions` (with `subscriptionId`, its deliveries) and
`delete_subscription`. These call the same services as REST.
`PATCH /api/blips/:id` remains available to appropriately scoped PATs for workflow
corrections.

## Reconciliation

`GET /api/radars/:id/blips?updatedSince=<ISO8601>&sort=updated&includeArchived=true`
returns blips strictly newer than the timestamp, ordered ascending by
`(updatedAt, id)`. Either `sort=updated` or `updatedSince` selects this order,
independent of pins and lanes. Continue using `nextCursor` and the same timestamp;
the cursor preserves Postgres microseconds. These parameters also work through
MCP `read_radar`.

Keep an overlap between reconcile windows and deduplicate: DTO timestamps use
JavaScript millisecond precision, and concurrent edits can move a record ahead
of a cursor. This is a live traversal, not a database snapshot. `includeArchived`
is needed to see finished work outside its archive window. Deleted blips cannot
appear in an incremental list; reconcile stored links periodically against a
full radar listing or individual reads.

Apply migration `0032_outbound_subscriptions.sql` before running the updated API
and worker (the existing `MIGRATE_ON_BOOT` deployment path does this). No external
queue or new environment secret is required.
