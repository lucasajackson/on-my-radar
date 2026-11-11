/** Explicit REST-to-MCP coverage. The test requires classification of every new route. */
import { z } from 'zod';
import { boundary } from './result.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const INTEGRATION_HUMAN_ONLY =
  'Minting, rotating and revoking an integration credential, and connecting a Helpdesk to it, are human-only (HELPDESK §3.4).';
const DELIVERY_HUMAN_ONLY =
  'Setting where a client portal receives events, its signing secret, resuming and test pings are human-only; an agent may pause (HELPDESK §5.4).';
const PORTAL_ONLY =
  'The client portal surface takes only an integration credential, which is refused on /mcp (HELPDESK §5).';

export const endpointCoverage: Array<{ route: string; tool?: string; reason?: string }> = [
  {
    route: 'account-export:accountExportRoutes.get /export',
    reason: 'Complete account downloads require the owner’s active human browser session.',
  },
  {
    route: 'account-export:accountExportRoutes.post /export/object',
    reason: 'Private account export file tickets require the owner’s active human browser session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.post /start',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.post /recover',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.get /conversation',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.post /conversation',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.post /conversation/replies',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.post /conversation/revoke',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'guest-support:guestSupportRoutes.post /requests/:id/revoke',
    reason:
      'A guest capability authorizes one support conversation, never account data. Staff revocation requires the owner human session.',
  },
  {
    route: 'support:supportRoutes.get /',
    reason:
      'Native support requires the requester’s human browser session; staff use the shared helpdesk blip/comment services.',
  },
  {
    route: 'support:supportRoutes.post /',
    reason:
      'Native support requires the requester’s human browser session; staff use the shared helpdesk blip/comment services.',
  },
  {
    route: 'support:supportRoutes.get /:id',
    reason:
      'Native support requires the requester’s human browser session; staff use the shared helpdesk blip/comment services.',
  },
  {
    route: 'support:supportRoutes.post /:id/replies',
    reason:
      'Native support requires the requester’s human browser session; staff use the shared helpdesk blip/comment services.',
  },
  { route: 'integrations:integrationRoutes.get /', tool: 'list_integrations' },
  { route: 'integrations:integrationRoutes.post /', reason: INTEGRATION_HUMAN_ONLY },
  { route: 'integrations:integrationRoutes.post /:id/rotate', reason: INTEGRATION_HUMAN_ONLY },
  {
    route: 'integrations:integrationRoutes.post /:id/revoke-previous',
    reason: INTEGRATION_HUMAN_ONLY,
  },
  { route: 'integrations:integrationRoutes.post /:id/revoke', reason: INTEGRATION_HUMAN_ONLY },
  { route: 'integrations:integrationRoutes.post /:id/radars', reason: INTEGRATION_HUMAN_ONLY },
  {
    route: 'integrations:integrationRoutes.delete /:id/radars/:radarId',
    tool: 'unenroll_helpdesk_radar',
  },
  { route: 'helpdesk:helpdeskRoutes.get /radars', reason: PORTAL_ONLY },
  { route: 'helpdesk:helpdeskRoutes.get /radars/:radarId/requests', reason: PORTAL_ONLY },
  { route: 'helpdesk:helpdeskRoutes.post /radars/:radarId/requests', reason: PORTAL_ONLY },
  { route: 'helpdesk:helpdeskRoutes.get /requests/:id', reason: PORTAL_ONLY },
  { route: 'helpdesk:helpdeskRoutes.post /requests/:id/replies', reason: PORTAL_ONLY },
  { route: 'helpdesk:helpdeskRoutes.get /events', reason: PORTAL_ONLY },
  { route: 'integrations:integrationRoutes.put /:id/delivery', reason: DELIVERY_HUMAN_ONLY },
  {
    route: 'integrations:integrationRoutes.post /:id/delivery/rotate-secret',
    reason: DELIVERY_HUMAN_ONLY,
  },
  {
    route: 'integrations:integrationRoutes.post /:id/delivery/pause',
    tool: 'pause_integration_delivery',
  },
  {
    route: 'integrations:integrationRoutes.post /:id/delivery/resume',
    reason: DELIVERY_HUMAN_ONLY,
  },
  { route: 'integrations:integrationRoutes.post /:id/delivery/test', reason: DELIVERY_HUMAN_ONLY },
  {
    route: 'integrations:integrationRoutes.get /:id/deliveries',
    tool: 'list_integrations',
  },
  { route: 'subscriptions:subscriptionRoutes.get /:id/subscriptions', tool: 'list_subscriptions' },
  {
    route: 'subscriptions:subscriptionRoutes.post /:id/subscriptions',
    reason: 'Outbound credential creation and delivery controls are human-only.',
  },
  {
    route: 'subscriptions:subscriptionRoutes.patch /:id/subscriptions/:subscriptionId',
    reason: 'Outbound credential creation and delivery controls are human-only.',
  },
  {
    route: 'subscriptions:subscriptionRoutes.delete /:id/subscriptions/:subscriptionId',
    tool: 'delete_subscription',
  },
  {
    route: 'subscriptions:subscriptionRoutes.post /:id/subscriptions/:subscriptionId/rotate',
    reason: 'Outbound credential creation and delivery controls are human-only.',
  },
  {
    route: 'subscriptions:subscriptionRoutes.post /:id/subscriptions/:subscriptionId/test',
    reason: 'Outbound credential creation and delivery controls are human-only.',
  },
  {
    route: 'subscriptions:subscriptionRoutes.get /:id/subscriptions/:subscriptionId/deliveries',
    tool: 'list_subscriptions',
  },
  { route: 'blips:blipRoutes.get /:id/reminder', tool: 'get_blip' },
  {
    route: 'blips:blipRoutes.put /:id/reminder',
    reason: 'Personal reminder consent is human-only; set it in the blip reminder controls.',
  },
  {
    route: 'blips:blipRoutes.delete /:id/reminder',
    reason: 'Personal reminder consent is human-only; set it in the blip reminder controls.',
  },
  {
    route: 'notifications:notificationRoutes.delete /push/:deviceId',
    reason: 'Push device registration and revocation are human-only settings.',
  },
  {
    route: 'admin:adminRoutes.get /users',
    reason: 'Operator-only user administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.post /users/:id',
    reason: 'Operator-only user administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.get /agents',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.get /tokens',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.post /agents/:id/revoke',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.post /tokens/pat/:id/revoke',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.post /tokens/oauth/:userId/:clientId/revoke',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.get /overview',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.get /models',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.post /models',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.patch /models/:id',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'admin:adminRoutes.delete /models/:id',
    reason: 'Operator-only administration is outside the account MCP surface.',
  },
  {
    route: 'auth:authRoutes.get /config',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.get /session',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.post /request-code',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.post /verify-code',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.get /sessions',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.delete /sessions/:id',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.post /logout',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.patch /profile',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.get /oidc/start',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'auth:authRoutes.get /oidc/callback',
    reason:
      'Session, login and account identity controls belong to the signed-in person; MCP authenticates through OAuth or a personal token.',
  },
  {
    route: 'blips:blipRoutes.get /',
    tool: 'search_blips',
  },
  {
    route: 'blips:blipRoutes.get /tags',
    tool: 'list_tags',
  },
  {
    route: 'blips:blipRoutes.get /:id',
    tool: 'get_blip',
  },
  {
    route: 'blips:blipRoutes.patch /:id',
    tool: 'update_blip',
  },
  { route: 'blips:blipRoutes.post /:id/claim', tool: 'claim_blip' },
  { route: 'blips:blipRoutes.get /:id/revisions', tool: 'list_blip_revisions' },
  { route: 'blips:blipRoutes.post /:id/decide', tool: 'decide_adr' },
  { route: 'blips:blipRoutes.get /:id/trace', tool: 'trace' },
  {
    route: 'blips:blipRoutes.get /:id/decisions',
    reason:
      'The card’s request panel reads it; an agent that asked is told the answer through its notification queue.',
  },
  { route: 'blips:blipRoutes.post /:id/decisions', tool: 'request_decision' },
  {
    route: 'blips:blipRoutes.post /:id/decisions/:requestId/answer',
    reason:
      'Answering a question put to a person is that person’s own decision on a real screen; an agent can ask but never answer.',
  },
  {
    route: 'blips:blipRoutes.delete /:id',
    tool: 'delete_blip',
  },
  {
    route: 'blips:blipRoutes.get /:id/comments',
    tool: 'list_comments',
  },
  {
    route: 'blips:blipRoutes.post /:id/comments',
    tool: 'create_comment',
  },
  {
    route: 'blips:blipRoutes.post /:id/reactions',
    tool: 'react_to_blip',
  },
  {
    route: 'blips:commentRoutes.patch /:id',
    tool: 'update_comment',
  },
  {
    route: 'blips:commentRoutes.delete /:id',
    tool: 'delete_comment',
  },
  {
    route: 'blips:commentRoutes.post /:id/release',
    reason:
      'Releasing a reply to a client is the radar owner’s review (docs/HELPDESK.md §7.2): ' +
      'human-only. An agent drafts with create_comment visibility "client"; the owner releases it in On My Radar.',
  },
  {
    route: 'blips:webhookRoutes.patch /:id',
    tool: 'update_webhook',
  },
  {
    route: 'blips:webhookRoutes.post /:id/rotate',
    tool: 'rotate_webhook_secret',
  },
  {
    route: 'blips:webhookRoutes.delete /:id',
    tool: 'delete_webhook',
  },
  {
    route: 'blips:attachmentRoutes.get /:id',
    tool: 'download_attachment',
  },
  { route: 'blips:attachmentRoutes.get /:id/image', tool: 'read_attachment_image' },
  {
    route: 'blips:blipRoutes.get /:id/email',
    tool: 'get_email',
  },
  {
    route: 'blips:blipRoutes.get /:id/email/original',
    tool: 'download_original_email',
  },
  {
    route: 'dashboards:dashboardRoutes.get /',
    tool: 'list_dashboards',
  },
  {
    route: 'dashboards:dashboardRoutes.post /',
    tool: 'create_dashboard',
  },
  {
    route: 'dashboards:dashboardRoutes.post /preview',
    tool: 'preview_dashboard_query',
  },
  {
    route: 'dashboards:dashboardRoutes.get /:id/widgets/:widgetId/results',
    tool: 'preview_dashboard_query',
  },
  {
    route: 'dashboards:dashboardRoutes.patch /:id',
    tool: 'update_dashboard',
  },
  {
    route: 'dashboards:dashboardRoutes.delete /:id',
    tool: 'delete_dashboard',
  },
  {
    route: 'health:healthRoutes.get /live',
    reason: 'Infrastructure liveness and readiness probes.',
  },
  {
    route: 'health:healthRoutes.get /ready',
    reason: 'Infrastructure liveness and readiness probes.',
  },
  {
    route: 'hooks:hookRoutes.post /:id/:token',
    reason: 'External webhook delivery protocol; agents capture through create_blip.',
  },
  {
    route: 'hooks:hookRoutes.put /:id/:token',
    reason: 'External webhook delivery protocol; agents capture through create_blip.',
  },
  {
    route: 'hooks:hookRoutes.get /:id/:token',
    reason: 'External webhook delivery protocol; agents capture through create_blip.',
  },
  {
    route: 'inbound-email:emailCaptureRoutes.get /email-capture',
    reason:
      'Email ingress is an authenticated machine protocol; sender authorization and email addresses are human-only settings.',
  },
  {
    route: 'inbound-email:emailCaptureRoutes.put /email-capture',
    reason:
      'Email ingress is an authenticated machine protocol; sender authorization and email addresses are human-only settings.',
  },
  {
    route: 'inbound-email:emailCaptureRoutes.get /radars/:id/email-capture',
    reason:
      'Email ingress is an authenticated machine protocol; sender authorization and email addresses are human-only settings.',
  },
  {
    route: 'inbound-email:emailCaptureRoutes.put /radars/:id/email-capture',
    reason:
      'Email ingress is an authenticated machine protocol; sender authorization and email addresses are human-only settings.',
  },
  {
    route: 'inbound-email:emailIngestRoutes.post /raw',
    reason:
      'Email ingress is an authenticated machine protocol; sender authorization and email addresses are human-only settings.',
  },
  {
    route: 'inbound-email:emailIngestRoutes.all *',
    reason:
      'Email ingress is an authenticated machine protocol; sender authorization and email addresses are human-only settings.',
  },
  {
    route: 'invites:inviteRoutes.get /:token',
    reason: 'Browser invitation acceptance requires the intended signed-in recipient.',
  },
  {
    route: 'waitlist:waitlistRoutes.post /',
    reason: 'The public waitlist form, for people who have no account for an agent to act as.',
  },
  {
    route: 'mcp:mcpRoutes.all /',
    reason: 'MCP transport itself, not a content capability.',
  },
  {
    route: 'notifications:notificationRoutes.get /',
    tool: 'list_notifications',
  },
  {
    route: 'notifications:notificationRoutes.get /counts',
    tool: 'list_notifications',
  },
  {
    route: 'notifications:notificationRoutes.post /read',
    tool: 'mark_notifications_read',
  },
  {
    route: 'notifications:notificationRoutes.post /seen',
    reason:
      'Clearing the notification tray badge is an attention control like reminders: human-only. mark_notifications_read finishes individual items.',
  },
  {
    route: 'notifications:notificationRoutes.get /settings',
    tool: 'get_notification_settings',
  },
  {
    route: 'notifications:notificationRoutes.patch /settings',
    reason:
      'Notification delivery preferences and browser push permissions are human-only in Settings \u2192 Notifications.',
  },
  {
    route: 'notifications:notificationRoutes.post /push',
    reason:
      'Notification delivery preferences and browser push permissions are human-only in Settings \u2192 Notifications.',
  },
  {
    route: 'notifications:notificationRoutes.post /push/unsubscribe',
    reason:
      'Notification delivery preferences and browser push permissions are human-only in Settings \u2192 Notifications.',
  },
  {
    route: 'oauth:wellKnownRoutes.get /oauth-protected-resource',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:wellKnownRoutes.get /oauth-authorization-server',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:wellKnownRoutes.get /openid-configuration',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:oauthRoutes.post /register',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:oauthRoutes.get /authorize',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:oauthRoutes.post /authorize/decision',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:oauthRoutes.get /client/:clientId',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'oauth:oauthRoutes.post /token',
    reason: 'OAuth transport and consent protocol, not an account content tool.',
  },
  {
    route: 'public:publicRoutes.get /radars/:slug',
    reason:
      'Anonymous public presentation and share-card routes; MCP uses authenticated content tools.',
  },
  {
    route: 'public:publicRoutes.get /radars/:slug/blips',
    reason:
      'Anonymous public presentation and share-card routes; MCP uses authenticated content tools.',
  },
  {
    route: 'public:publicRoutes.get /radars/:slug/blips/:blipId/comments',
    reason:
      'Anonymous public presentation and share-card routes; MCP uses authenticated content tools.',
  },
  {
    route: 'public:publicRoutes.get /radars/:slug/attachments/:attachmentId',
    reason:
      'Anonymous public presentation and share-card routes; MCP uses authenticated content tools.',
  },
  {
    route: 'public:publicRoutes.get /radars/:slug/card.svg',
    reason:
      'Anonymous public presentation and share-card routes; MCP uses authenticated content tools.',
  },
  {
    route: 'public:publicRoutes.get /radars/:slug/blips/:id/email',
    reason:
      'Anonymous public presentation and share-card routes; MCP uses authenticated content tools.',
  },
  {
    route: 'radars:radarRoutes.get /',
    tool: 'list_radars',
  },
  {
    route: 'radars:radarRoutes.post /',
    tool: 'create_radar',
  },
  {
    route: 'radars:radarRoutes.post /smart',
    tool: 'create_radar',
  },
  {
    route: 'radars:radarRoutes.get /drop-box',
    tool: 'read_drop_box',
  },
  {
    route: 'radars:radarRoutes.get /:id',
    tool: 'read_radar',
  },
  {
    route: 'radars:radarRoutes.patch /:id',
    tool: 'update_radar',
  },
  {
    route: 'radars:radarRoutes.delete /:id',
    tool: 'delete_radar',
  },
  {
    route: 'radars:radarRoutes.put /:id/visibility',
    tool: 'set_radar_visibility',
  },
  {
    route: 'radars:radarRoutes.post /:id/rotate-link',
    tool: 'set_radar_visibility',
  },
  {
    route: 'radars:radarRoutes.get /:id/members',
    tool: 'list_radar_members',
  },
  {
    route: 'radars:radarRoutes.post /:id/members',
    tool: 'share_radar',
  },
  {
    route: 'radars:radarRoutes.delete /:id/members/:userId',
    tool: 'remove_radar_member',
  },
  {
    route: 'radars:radarRoutes.delete /:id/invites',
    tool: 'remove_radar_member',
  },
  {
    route: 'radars:radarRoutes.put /:id/notify-level',
    reason: 'Personal notification preferences are human-only in radar settings.',
  },
  {
    route: 'radars:radarRoutes.put /:id/topic',
    tool: 'set_radar_array',
  },
  {
    route: 'radars:radarRoutes.get /:id/blips',
    tool: 'read_radar',
  },
  {
    route: 'radars:radarRoutes.post /:id/blips',
    tool: 'create_blip',
  },
  { route: 'radars:radarRoutes.get /:id/architecture', tool: 'read_architecture' },
  { route: 'radars:radarRoutes.post /:id/adrs', tool: 'propose_adr' },
  { route: 'radars:radarRoutes.put /:id/charter', tool: 'write_charter' },
  { route: 'radars:radarRoutes.post /:id/charter/edits', tool: 'edit_charter' },
  { route: 'anchors:anchorRoutes.post /:id/reanchor', tool: 'reanchor' },
  { route: 'anchors:anchorRoutes.post /:id/dismiss', tool: 'reanchor' },
  {
    route: 'radars:radarRoutes.post /:id/charter-pages',
    reason:
      'Retired: the charter is one document and the route always answers 410 charter_is_one_document. Change it with edit_charter or write_charter.',
  },
  { route: 'radars:radarRoutes.post /:id/charter/links', tool: 'link_charter' },
  { route: 'radars:radarRoutes.get /:id/charter/versions', tool: 'list_charter_versions' },
  { route: 'radars:radarRoutes.get /:id/charter/diff', tool: 'diff_charter' },
  {
    route: 'radars:radarRoutes.post /:id/charter/versions/:version/restore',
    tool: 'write_charter',
  },
  { route: 'radars:radarRoutes.post /:id/boundaries', tool: 'upsert_boundary' },
  { route: 'radars:radarRoutes.post /:id/contracts', tool: 'upsert_contract' },
  {
    route: 'radars:radarRoutes.get /:id/facets',
    tool: 'read_radar',
  },
  {
    route: 'radars:radarRoutes.get /:id/webhooks',
    tool: 'list_webhooks',
  },
  {
    route: 'radars:radarRoutes.post /:id/webhooks',
    tool: 'create_webhook',
  },
  {
    route: 'radars:radarRoutes.post /:id/uploads',
    tool: 'create_upload_ticket',
  },
  {
    route: 'rss:rssRouter.get /:id/feeds',
    tool: 'list_feeds',
  },
  {
    route: 'rss:rssRouter.post /:id/feeds',
    tool: 'set_feed',
  },
  {
    route: 'rss:rssRouter.patch /:id/feeds/:feedId',
    tool: 'set_feed',
  },
  {
    route: 'rss:rssRouter.delete /:id/feeds/:feedId',
    tool: 'delete_feed',
  },
  {
    route: 'search:searchRoutes.get /',
    tool: 'search_blips',
  },
  {
    route: 'search:searchRoutes.get /suggest',
    reason:
      'Search-box autocomplete. list_radars gives the names in: accepts, and search_blips reports a filter it could not resolve.',
  },
  {
    route: 'tokens:tokenRoutes.get /',
    reason:
      'Credentials, and which agent a credential writes as, are human-only in Settings \u2192 Connections.',
  },
  {
    route: 'tokens:tokenRoutes.post /agents',
    reason:
      'Credentials, and which agent a credential writes as, are human-only in Settings \u2192 Connections.',
  },
  {
    route: 'tokens:tokenRoutes.delete /agents/:id',
    reason:
      'Credentials, and which agent a credential writes as, are human-only in Settings \u2192 Connections.',
  },
  {
    route: 'tokens:tokenRoutes.post /',
    reason:
      'Credentials, and which agent a credential writes as, are human-only in Settings \u2192 Connections.',
  },
  {
    route: 'tokens:tokenRoutes.delete /:id',
    reason:
      'Credentials, and which agent a credential writes as, are human-only in Settings \u2192 Connections.',
  },
  {
    route: 'tokens:tokenRoutes.get /grants',
    reason:
      'Connected apps are credentials; listing and disconnecting them is human-only in Settings.',
  },
  {
    route: 'tokens:tokenRoutes.delete /grants/:clientId',
    reason:
      'Connected apps are credentials; listing and disconnecting them is human-only in Settings.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /',
    tool: 'list_agents',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /',
    tool: 'create_agent',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /import',
    tool: 'create_agent',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id',
    tool: 'list_agents',
  },
  {
    route: 'repo-agents:repoAgentRoutes.patch /:id',
    tool: 'update_agent',
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id',
    reason:
      "Deleting an agent destroys its prompt history and memory; it is the owner's decision on a real screen.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/archived',
    reason:
      'Archiving takes an agent away from every device; the owner decides it on a real screen.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/prompts',
    tool: 'agent_activity',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/prompts/:version',
    tool: 'get_agent_prompt',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/prompts',
    tool: 'update_agent_prompt',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/prompt-proposals',
    reason:
      'Held prompt changes are reviewed by the owner in On My Radar; update_agent_prompt answers with the proposal id.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/prompt-proposals/:proposalId/accept',
    reason:
      'An agent cannot accept a change to a prompt, its own or anyone’s; the owner decides in a signed-in browser.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/prompt-proposals/:proposalId/reject',
    reason: 'Rejecting a held prompt change is the owner’s review, in a signed-in browser.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/load',
    tool: 'load_agent',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/sessions',
    reason:
      "Session history is shown on the agent's page; load_agent reports the session an agent needs.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/memories',
    tool: 'agent_recall',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/memories',
    tool: 'agent_remember',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/memories/forget',
    tool: 'agent_forget',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/memories/:memoryId/revisions',
    reason: "Memory history is the owner's audit view in On My Radar.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/memories/:memoryId/restore',
    reason: "Restoring a forgotten memory is a person's decision.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/memories/:memoryId/pin',
    reason: 'Pinning decides what every session reads first; a person decides it.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/memories/:memoryId/promote',
    reason: "Putting a memory on a radar is a person's decision; agents use create_blip.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/checkout',
    tool: 'checkout_agent',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/export',
    tool: 'export_agent',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /handles/:handle',
    reason: 'create_agent derives a free handle from the name and answers a taken one with a 409.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/lock',
    reason:
      'Locking the prompt is how the owner stops agents changing it; an agent cannot lock or unlock itself.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/agent-edits',
    reason:
      'Whether other agents may change this prompt live is the owner’s decision; an agent cannot grant itself or a sibling that.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/radars',
    reason:
      'Which radars an agent may reach is the owner’s decision; an agent cannot widen or lift its own limit.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/duplicate',
    reason: 'A screen convenience; an agent composes export_agent and create_agent.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/profiles',
    tool: 'get_agent_profiles',
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/profiles/:harness',
    tool: 'set_agent_profile',
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id/profiles/:harness',
    tool: 'delete_agent_profile',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/briefs',
    tool: 'list_agent_briefs',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/briefs/:name',
    tool: 'get_agent_brief',
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/briefs/:name',
    tool: 'update_agent_brief',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/briefs/:name/revisions',
    reason:
      'A brief’s history is the review view on the agent’s Briefs tab; get_agent_brief reads any revision by number.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/briefs/:name/rename',
    tool: 'rename_agent_brief',
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/briefs/:name/binding',
    reason:
      'Binding a brief to a repository points this server’s GitLab credentials at it; it is the owner’s decision on the agent’s Briefs tab. list_agent_briefs and get_agent_brief report what the binding found as `stale`.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id/briefs/:name/binding',
    reason:
      'Binding a brief to a repository points this server’s GitLab credentials at it; it is the owner’s decision on the agent’s Briefs tab.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id/briefs/:name',
    reason:
      'Deleting a brief destroys every revision of it, for everyone the agent is shared with; it is the owner’s decision on a real screen.',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/activity',
    tool: 'agent_activity',
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/shares',
    reason:
      "Who may run an agent, and whose memory edits load into the owner's sessions, is the owner's decision on the agent's Sharing tab.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/shares',
    reason:
      "Who may run an agent, and whose memory edits load into the owner's sessions, is the owner's decision on the agent's Sharing tab.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.patch /:id/shares/:type/:subjectId',
    reason:
      "Who may run an agent, and whose memory edits load into the owner's sessions, is the owner's decision on the agent's Sharing tab.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id/shares/:type/:subjectId',
    reason:
      "Who may run an agent, and whose memory edits load into the owner's sessions, is the owner's decision on the agent's Sharing tab.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/accept',
    reason:
      "Accepting, updating, following or leaving a shared agent is the recipient's decision, made after reading it in On My Radar.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id/accept',
    reason:
      "Accepting, updating, following or leaving a shared agent is the recipient's decision, made after reading it in On My Radar.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/update',
    reason:
      "Accepting, updating, following or leaving a shared agent is the recipient's decision, made after reading it in On My Radar.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.put /:id/follow',
    reason:
      "Accepting, updating, following or leaving a shared agent is the recipient's decision, made after reading it in On My Radar.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/transfer',
    reason:
      "Handing an agent to someone, and taking one, is a person's decision; the new owner accepts on a real screen.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.delete /:id/transfer',
    reason:
      "Handing an agent to someone, and taking one, is a person's decision; the new owner accepts on a real screen.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/transfer/accept',
    reason:
      "Handing an agent to someone, and taking one, is a person's decision; the new owner accepts on a real screen.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/transfer/decline',
    reason:
      "Handing an agent to someone, and taking one, is a person's decision; the new owner accepts on a real screen.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.get /:id/connections',
    reason:
      "Credentials are an inventory of somebody's access; listing them is session-only, in On My Radar.",
  },
  {
    route: 'repo-agents:repoAgentRoutes.post /:id/connections',
    reason:
      'An agent cannot issue its own credentials; minting a token is session-only, in On My Radar.',
  },
  {
    route: 'repo-agents:modelRoutes.get /',
    reason:
      "The model list serves the profile editor; set_agent_profile checks a model id's shape and accepts any id the tool does.",
  },
  {
    route: 'topics:topicRoutes.get /',
    tool: 'list_arrays',
  },
  {
    route: 'topics:topicRoutes.post /',
    tool: 'create_array',
  },
  {
    route: 'topics:topicRoutes.get /:id',
    tool: 'read_array',
  },
  {
    route: 'topics:topicRoutes.patch /:id',
    tool: 'update_array',
  },
  {
    route: 'topics:topicRoutes.delete /:id',
    tool: 'delete_array',
  },
  {
    route: 'topics:topicRoutes.put /:id/cascade',
    reason:
      'Changing cascading access requires the person to review its impact on the array screen.',
  },
  {
    route: 'topics:topicRoutes.get /:id/members',
    tool: 'list_array_members',
  },
  {
    route: 'topics:topicRoutes.post /:id/members',
    tool: 'share_array',
  },
  {
    route: 'topics:topicRoutes.delete /:id/members/:userId',
    tool: 'remove_array_member',
  },
  {
    route: 'topics:topicRoutes.delete /:id/invites',
    tool: 'remove_array_member',
  },
];

export const capabilityGuide = {
  scope:
    'Search and content tools cover every radar this connection can access. The connection permission ceiling always applies.',
  search:
    'Use search_blips with preferRadarId to put the current radar first while searching all accessible radars. radarId restricts the search instead. list_radars gives the names `in:` accepts.',
  dashboards:
    'list_dashboards, create_dashboard, update_dashboard and delete_dashboard manage dashboards; Create an empty dashboard, then use update_dashboard append or operations to merge widget changes safely. Full widgets replacement requires expectedRevision. Query displays include list, count, lanes and activity, with exact full-query totals. preview_dashboard_query validates a query, or with dashboardId and widgetId retrieves a saved widget’s live results.',
  humanOnly: [
    {
      feature: 'Email address and approved senders',
      location: 'Settings and the radar Sources tab',
      reason: 'The account or radar owner must authorize who can send email.',
    },
    {
      feature: 'Notification delivery and push permission',
      location: '/settings/notifications',
      reason: 'Personal attention preferences remain under human control.',
    },
    {
      feature: 'Cascading array access',
      location: '/array/:id',
      reason: 'The person must review the access changes before applying them.',
    },
    {
      feature: 'New-user invitations',
      location: 'Radar or array sharing dialog',
      reason:
        'Sharing tools can use existing accounts; inviting a new account requires a human decision.',
    },
    {
      feature: 'Credentials, agent identity and account profile',
      location: '/settings/connections and /settings/profile',
      reason:
        'An agent cannot issue its own credentials or change the identity under which it acts.',
    },
    {
      feature: 'Sharing, accepting, transferring, archiving and locking an agent',
      location: "The agent's page in /repo",
      reason:
        'Who runs an agent, whose prompt reaches whose tools, and whether agents may edit a prompt are people\u2019s decisions.',
    },
    {
      feature: 'Binding a brief to a repository, and its one-way mirror',
      location: "The agent's Briefs tab in /repo",
      reason:
        'A binding points this server\u2019s GitLab credentials at a repository and can open merge requests in it; agents read what it found as the `stale` field of a brief.',
    },
    {
      feature: 'Releasing a reply to a client on a Helpdesk radar',
      location: 'The reply, in the blip\u2019s conversation',
      reason:
        'No free text reaches a client without the radar owner\u2019s review. An agent drafts with create_comment visibility "client" (it lands as client_pending); the owner releases the exact text they read.',
    },
  ],
  endpoints: endpointCoverage,
};

export function registerCapabilities(server: McpServer): void {
  server.registerTool(
    'list_capabilities',
    {
      title: 'Application capabilities',
      description:
        'Discover where human-only account controls live. Returns a summary; section "endpoints" is the full REST-to-MCP map (large). Use tools/list for current input schemas.',
      inputSchema: {
        section: z
          .enum(['endpoints'])
          .optional()
          .describe('Omit for the summary; "endpoints" for every REST route and its tool.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ section }) => {
      // `endpoints` stays an array in both: the summary sends none and says where the rest is.
      const body =
        section === 'endpoints'
          ? { endpoints: capabilityGuide.endpoints }
          : {
              ...capabilityGuide,
              endpoints: [],
              more: `${capabilityGuide.endpoints.length} REST routes are mapped; pass section "endpoints" for them.`,
            };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    },
  );
  server.registerResource(
    'capabilities',
    'onmyradar://capabilities',
    { title: 'Application capabilities', mimeType: 'application/json' },
    (uri) =>
      boundary('resource capabilities', () => ({
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(capabilityGuide) },
        ],
      })),
  );
}
