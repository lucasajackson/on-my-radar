# Component: M10 Notifications and push

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Turns domain events into coalesced per-user notification rows and delivers them: in-app, email (Resend) and push (Web Push and APNs). It owns the preferences, the per-device push receipts, the reminder-time delivery, and the transactional mail module that also sends sign-in codes and invitations.

**Depends on:** M3 (live readers), M11 (outbox jobs), M1 (sessions bound to devices), M20, M25 (notification kinds).

**Used by:** M5, M7, M13, M16, M18, M21 (they enqueue events), the UI and iOS client (reading).

**Invariants (and what enforces each):**

- Coalescing is decided by the database: partial unique index `notifications_open_group_key (user_id, group_key) WHERE read_at IS NULL`; the upsert's `xmax = 0` says whether to deliver, so ten reactions fold into one notification. A mention never folds with other sources: its key is per comment or per blip, so repeating the same mention before the first is read folds into it (`services/notifications.ts`; `notifications.test.ts`).
- Recipients are re-derived from live membership every time (`radarReaders`), only `active` users get a row, and a per-radar level of `none` suppresses everything except `share`, `topic_share` and `topic_cascade` (and `subscription_failed`, which is inserted directly for the subscription's creator without a level or state check) (`notification-preferences.ts`; `notification-events.test.ts`).
- The cause's transaction inserts a `notification-event` outbox row; the fan-out and its done-marker commit together, so a replay cannot fold twice.
- `emailed_at` is stamped after Resend accepts the mail (or after the send is skipped for a closed-account recipient), and `pushed_at` records provider acceptance, not that a person saw anything.
- Push is per device with a durable receipt: unique `(notification_id, destination_kind, destination_id, generation)` on `push_deliveries`; delivery rechecks device generation, live session, notification access and preference, then builds a fresh payload (`services/push-delivery.ts`; `native-push.test.ts`).
- A `due` reminder is revalidated at queue time and send time and expires one hour after its time (`services/reminders.ts`).
- Device registration is human-only, needs a live session of the matching client, and is limited to 120 registrations per session per hour and 20 active devices per user (`services/push-devices.ts`).
- Notifications addressed to an agent are queue rows and are never emailed or pushed (`deliver`).
- Read notifications older than 60 days are purged by the worker, as are push receipts 30 days after they expire and session-less push subscriptions older than 30 days.

## 2. Owned data

| Owned                                                      | Kind  | Notes                                         |
| ---------------------------------------------------------- | ----- | --------------------------------------------- |
| `notifications`                                            | table |                                               |
| `user_notification_settings`                               | table |                                               |
| `radar_notification_prefs`                                 | table |                                               |
| `push_deliveries`                                          | table |                                               |
| `push_devices`                                             | table |                                               |
| `push_subscriptions`                                       | table |                                               |
| `packages/server/src/services/notifications.ts`            | file  | Events, fan-out, coalescing, delivery         |
| `packages/server/src/services/notification-preferences.ts` | file  | Defaults and per-radar levels                 |
| `packages/server/src/services/push.ts`                     | file  | Web Push (RFC 8291, 8188, 8292), hand-written |
| `packages/server/src/services/push-delivery.ts`            | file  | Per-device receipts and the push job          |
| `packages/server/src/services/push-devices.ts`             | file  | Device registration                           |
| `packages/server/src/services/apns.ts`                     | file  | APNs over HTTP/2                              |
| `packages/server/src/services/mail.ts`                     | file  | Resend client and queued email                |
| `packages/server/src/services/mail-layout.ts`              | file  | Email layout                                  |
| `packages/server/src/routes/notifications.ts`              | file  | Mounted at `/api/notifications`               |

## 3. Interface

- **Routes:** `GET /api/notifications`, `GET /counts`, `POST /read`, `POST /seen`, `GET|PATCH /settings`, `POST /push` (web, or native when the body carries `platform`), `POST /push/unsubscribe`, `DELETE /push/:deviceId`.
- **MCP tools:** `list_notifications`, `mark_notifications_read`, `get_notification_settings`. There is no tool to change settings, mark the tray seen or register push.
- **Kinds (11):** `subscription_failed`, `comment`, `mention`, `reaction`, `share`, `blip`, `topic_share`, `topic_cascade`, `email_received`, `due`, `reply_pending`.
- **Configuration:** `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL`; `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION_KEY_ID`, `APNS_PRODUCTION_PRIVATE_KEY`, `APNS_SANDBOX_KEY_ID`, `APNS_SANDBOX_PRIVATE_KEY` (each key id and key must appear together, with the team id).

## 4. Failure and degradation

- Fan-out never fails the action that caused it. A transport that is not configured is reported unavailable in `GET /settings` (`transportAvailability`); registering a native device for an unconfigured APNs environment answers 400, whereas web push registration is accepted and simply never delivered. FCM does not exist and is reported false.
- Web Push endpoints answering 404 or 410 are deleted; APNs `Unregistered` and `BadDeviceToken` cancel the receipt and delete the device row, unless Apple's timestamp predates the registration.

## 5. Known gaps and unverified facts

- Whether production has the APNs or VAPID keys installed is not knowable from this repository; the push secret is mounted by the chart.
- `docs/NATIVE.md` lists `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_ENVIRONMENT` and `FCM_SERVICE_ACCOUNT_JSON`; the code uses per-environment key pairs and has no FCM. `docs/DEPLOY.md` matches the code.
- `NOTIFICATIONS.pushFailureLimit` is declared in the contract and unused; `push_subscriptions.failure_count` is only ever set to 0.
- `subscription_failed` is inserted directly and has no email or push.
