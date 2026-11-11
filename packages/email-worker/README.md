# Email relay

Cloudflare Email Routing invokes this email-only Worker. It streams the original
MIME message to the On My Radar API over HTTPS. The relay signs the
recipient, declared byte length, timestamp and random request nonce with HMAC.
It does not buffer or hash the full message, parse MIME, verify DKIM, or access
R2. Its only bindings are `API_ORIGIN` and the `EMAIL_INGEST_SECRET` secret.
Workers development and preview URLs are disabled; there is no HTTP entrypoint.

The API's receiver authenticates the relay before reading the bounded body.
It admits two concurrent messages per API process, with no waiting queue, and
applies a 20-second read/parse/storage budget. MIME/DKIM work runs in isolated Node
threads with a 64 MiB V8 heap limit; message buffers have their own 10 MiB cap.
An already-started database transaction retains its admission slot until it
settles; receipt deduplication handles retries if the relay times out first.
It independently verifies the original message with `mailauth`, parses it with
`postal-mime`, checks live radar ownership and exact approved-sender permission,
writes allowed attachments into the attachment bucket, then finalizes capture.
The ordinary blip service, atomic receipt and cleanup outbox retain their existing
transaction and deduplication guarantees.

Only SHA-256 DKIM signatures from the **exact From domain** qualify. The entire
body must be signed, along with present Subject/MIME interpretation headers.
Duplicate interpretation headers, multiple authors, missing/expired signatures,
weak signatures, and `l=` body truncation are refused. Forward mail as a new
message from your approved address; unsigned forwarding and signatures from a
parent/subdomain are deliberately unsupported. `Authentication-Results` is never
authority. Temporary infrastructure failures are not converted into permanent
sender rejection. Limits: 10 MiB whole message, 12 attachments, eight signatures,
1,000 headers within a 64 KiB header block, MIME nesting depth 30, and
100 new deliveries per radar/day.

## Why a relay

The original receiver parsed and verified mail at the edge. On the Workers Free
plan the 10 ms CPU allowance cannot reliably support that for realistic message
sizes, so the edge only streams the message and the API does the MIME and
signature work. The relay needs no paid CPU override or Node compatibility.

See [Email Worker limits](https://developers.cloudflare.com/email-service/platform/limits/).

## Verification

```sh
pnpm --filter @onmyradar/email-worker test
pnpm --filter @onmyradar/email-worker test:runtime
pnpm --filter @onmyradar/email-worker build
pnpm --filter @onmyradar/server test
```

The workerd harness exercises streaming, metadata authentication and response
handling in the actual edge runtime, without Node compatibility. The server
suite covers signature verification and ingestion. The runtime harness creates
an isolated temporary HTTP test entry; it never deploys that entry or contacts
production storage.

## Deployment

Deploy the API first, with `EMAIL_CAPTURE_DOMAIN` set to the domain capture
addresses live on and `EMAIL_INGEST_SECRET` (32+ random characters) available.
Keep `EMAIL_CAPTURE_ENABLED=false` until the relay and routing are ready. The raw
receiver is `/hooks/email-capture/raw`.

The Worker's `API_ORIGIN` is not committed: `wrangler.jsonc` sets `keep_vars`, so
a value set in the Cloudflare dashboard survives deploys, and the first deploy
names it:

```sh
pnpm --filter @onmyradar/email-worker exec wrangler deploy --var API_ORIGIN:https://omr.example.com
pnpm --filter @onmyradar/email-worker exec wrangler secret put EMAIL_INGEST_SECRET
```

Without `API_ORIGIN` the relay fails closed and rejects mail. Use an
account-scoped credential with Workers Scripts Edit (including secrets), and a
zone-scoped credential with Email Routing Rules Edit/DNS Edit for routing.

Provide the same `EMAIL_INGEST_SECRET` to the API. Configure the zone's catch-all
rule to invoke `onmyradar-email-capture`, with plus-address support enabled. Verify
the raw route rejects invalid authentication and accepts a signed relay request,
then enable root-domain Email Routing MX records and send real signed mail,
including a radar alias and an attachment. Keep any existing sending provider's
DKIM, MX and SPF records. To suspend ingestion, set `EMAIL_CAPTURE_ENABLED=false`:
the UI reports the feature as unavailable and the receiver refuses capture.

## Design notes

The native-stream relay used 1 ms CPU for a 10,049,442-byte message. Do not add a
JavaScript per-chunk counter: a prior counter consumed 179 ms CPU. Cloudflare
supplies the initial size hint; the API enforces the authenticated exact length
and the 10 MiB cap. Use `redirect: 'manual'`, not `'error'` (unsupported by
Cloudflare fetch), and never follow redirects carrying the signed relay headers.
The native runtime regression covers that constraint.
