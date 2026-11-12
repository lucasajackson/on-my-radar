# On My Radar Helm chart

Runs [On My Radar](https://github.com/lucasajackson/on-my-radar) on Kubernetes: the app (API and web client), the outbox worker (mail, notifications, webhooks, feeds) and, for trying it out, a single Postgres.

You need a Kubernetes 1.25 or newer cluster, an ingress controller if you want it reachable from outside, and a Postgres 16 database (or `postgres.enabled=true` for a throwaway one).

## Install

Charts are published to GitHub's container registry when a release is tagged. For a first look, with a throwaway database:

```bash
helm install on-my-radar oci://ghcr.io/lucasajackson/charts/on-my-radar \
  --namespace on-my-radar --create-namespace \
  --set publicUrl=https://notes.example.com \
  --set secrets.sessionSecret=$(openssl rand -hex 32) \
  --set postgres.enabled=true --set postgres.password=$(openssl rand -hex 16) \
  --set ingress.enabled=true
```

`publicUrl` has no default: it is the address people and agents will use, and OAuth, MCP connections, webhook URLs and `/agent-setup/` are built from it, so it cannot move once clients have seen it. The install fails, naming the value, if it or the session secret is missing.

For a real install, bring your own Postgres and keep secrets out of values files:

```bash
kubectl create namespace on-my-radar
# Use your own secret tooling to make this Secret; the keys are environment variable names.
#   Required: SESSION_SECRET (32+ characters), DATABASE_URL
#   Optional: SMTP_URL, RESEND_API_KEY, OIDC_CLIENT_SECRET, S3_ACCESS_KEY, S3_SECRET_KEY
helm install on-my-radar oci://ghcr.io/lucasajackson/charts/on-my-radar \
  --namespace on-my-radar \
  --set publicUrl=https://notes.example.com \
  --set existingSecret=on-my-radar-secrets \
  --set mail.provider=smtp --set mail.from='On My Radar <notes@example.com>' \
  --set ingress.enabled=true --set ingress.tls.enabled=true --set ingress.tls.secretName=notes-tls
```

The image is `ghcr.io/lucasajackson/on-my-radar`. A released chart uses the image of the same version; a chart from a checkout uses `edge`, the latest main build. Set `image.tag` to pin either.

## What to know

- **Signing in.** Single-user mode (no sign-in at all) is for one machine and is not offered here: the server refuses to boot with it on a public address. Use `passwordLoginEnabled`, `oidc.*`, or neither: the emailed six-digit code always works, so mail has to work (`mail.provider`, and `secrets.smtpUrl` or `secrets.resendApiKey`). With no mail provider nobody can be sent a code.
- **The client-address header.** Sign-in limits are per client network and read from the request header named by `trustedIpHeader` (default `x-real-ip`). The server trusts it, so **your ingress must set it to the real client address and overwrite whatever the client sent**, or anyone can forge it and sidestep the limits. For ingress-nginx, `nginx.ingress.kubernetes.io/configuration-snippet: proxy_set_header X-Real-IP $remote_addr;` does it (some installs disable snippets; set it in the controller's config instead). Behind Cloudflare, set `trustedIpHeader` to `cf-connecting-ip`.
- **Migrations.** Pods run them on boot (`migrateOnBoot`). Several replicas starting together is fine: they take a database lock and the others wait. A waiting pod does not answer its health check until it has migrated, which is what the startup probe is for; raise `app.startupProbe.failureThreshold` for a very large upgrade.
- **Rolling updates.** The image carries only its own web client assets. A browser tab left open across an upgrade may fail to load a lazily fetched part of the page until it is reloaded.
- **Attachments** are off until `s3.endpoint` and the access keys are set. Any S3-compatible store works; none is bundled.
- **The development Postgres** (`postgres.enabled`) is one pod and one volume, with no backups or replication. The password is read when the database is first created; changing `postgres.password` later does not change it inside the volume.
- **Anything else** from [`.env.example`](../../.env.example) goes in `extraEnv`, or in your Secret if it is sensitive.

## Values

| Key | Default | Description |
| --- | --- | --- |
| `publicUrl` | `""` | **Required.** The address people and agents reach this install at. |
| `appUrl` | `""` | Where people go, when that differs from `publicUrl`. |
| `image.repository` | `ghcr.io/lucasajackson/on-my-radar` | Image to run. |
| `image.tag` | `""` | Image tag. Empty means the chart's `appVersion`. |
| `image.pullPolicy` | `IfNotPresent` | Image pull policy. |
| `imagePullSecrets` | `[]` | Pull secrets, if you mirror the image to a private registry. |
| `nameOverride` | `""` | Replaces the chart name in resource names and labels. |
| `fullnameOverride` | `""` | Replaces the whole resource name prefix. |
| `signupMode` | `open` | `open` lets every new sign-in straight in; `waitlist` queues them. |
| `adminEmails` | `""` | Comma-separated addresses that skip the waitlist and get the admin screen. |
| `passwordLoginEnabled` | `false` | Email and password sign-in (12+ characters). Needs mail. |
| `trustedIpHeader` | `x-real-ip` | Header your ingress sets to the client address. It must overwrite the client's value. |
| `mail.provider` | `""` | `smtp` or `resend`. Empty means no mail can be sent. |
| `mail.from` | `""` | Sender address your relay accepts. |
| `oidc.issuerUrl` | `""` | OpenID Connect issuer; set it to show the single sign-on button. |
| `oidc.clientId` | `""` | OpenID Connect client id. |
| `oidc.providerName` | `SSO` | Label of the single sign-on button. |
| `s3.endpoint` | `""` | S3-compatible endpoint; set it (with keys) to enable attachments. |
| `s3.region` | `us-east-1` | Bucket region. |
| `s3.bucket` | `on-my-radar` | Bucket name. |
| `s3.forcePathStyle` | `true` | Path-style bucket addressing, as most self-hosted stores need. |
| `extraEnv` | `[]` | Extra environment entries for app and worker (`name` and `value`, or `valueFrom`). |
| `migrateOnBoot` | `true` | Run migrations when a pod starts. |
| `existingSecret` | `""` | A Secret you made, with the keys listed above. The chart then makes none. |
| `secrets.sessionSecret` | `""` | 32+ characters. Required unless `existingSecret` is set. |
| `secrets.databaseUrl` | `""` | `postgres://user:password@host:5432/db`. Computed when `postgres.enabled`. |
| `secrets.smtpUrl` | `""` | `smtp://user:password@host:587` (STARTTLS is required). |
| `secrets.resendApiKey` | `""` | Resend API key. |
| `secrets.oidcClientSecret` | `""` | OpenID Connect client secret. |
| `secrets.s3AccessKey` | `""` | Object store access key. |
| `secrets.s3SecretKey` | `""` | Object store secret key. |
| `app.replicas` | `1` | App pods. |
| `app.resources` | requests 100m / 256Mi, memory limit 768Mi | App container resources. |
| `app.startupProbe.periodSeconds` | `5` | Startup probe interval (app and worker). |
| `app.startupProbe.failureThreshold` | `60` | Failures allowed before a starting pod is restarted; times the period, it is how long migrations may take. |
| `app.nodeSelector` | `{}` | App pod node selector. |
| `app.tolerations` | `[]` | App pod tolerations. |
| `app.affinity` | `{}` | App pod affinity. |
| `app.podAnnotations` | `{}` | App pod annotations. |
| `worker.enabled` | `true` | Run the outbox worker. Without it no mail, notification or webhook is delivered. |
| `worker.replicas` | `1` | Worker pods. |
| `worker.resources` | requests 50m / 192Mi, memory limit 512Mi | Worker container resources. |
| `worker.nodeSelector` | `{}` | Worker pod node selector. |
| `worker.tolerations` | `[]` | Worker pod tolerations. |
| `worker.affinity` | `{}` | Worker pod affinity. |
| `worker.podAnnotations` | `{}` | Worker pod annotations. |
| `service.type` | `ClusterIP` | Service type. |
| `service.port` | `3500` | Service port. |
| `ingress.enabled` | `false` | Create an Ingress for the host in `publicUrl`. |
| `ingress.className` | `""` | Ingress class. |
| `ingress.annotations` | `{}` | Ingress annotations (put the client-address header here). |
| `ingress.tls.enabled` | `false` | Add a TLS section for the host. |
| `ingress.tls.secretName` | `""` | Secret holding the certificate (empty lets your controller choose). |
| `postgres.enabled` | `false` | Run a throwaway single-pod Postgres. |
| `postgres.image.repository` | `postgres` | Postgres image. |
| `postgres.image.tag` | `16-alpine` | Postgres image tag. |
| `postgres.password` | `""` | Required when enabled; letters, digits and `. _ ~ -` only. |
| `postgres.persistence.size` | `2Gi` | Volume size. |
| `postgres.persistence.storageClass` | `""` | Volume storage class (empty is the cluster default). |
| `postgres.resources` | requests 50m / 128Mi, memory limit 512Mi | Postgres container resources. |

## Security

Pods run as a non-root user (uid 10001) with all capabilities dropped, no privilege escalation and the runtime's default seccomp profile. The chart creates no service account, role or network policy, and the pods do not mount a Kubernetes API token.

Values you pass with `--set secrets.*` are stored in the release's Helm state. Prefer `existingSecret`.
