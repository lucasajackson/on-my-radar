/** Explicit schema generations; partial migrations and unknown fields fail closed. */
import { ACCOUNT_EXPORT_TABLES, type ExportTablePolicy } from './account-export-tables.js';

const internal = (table: string, exclude: string[], reason: string): ExportTablePolicy => ({
  table,
  include: [],
  exclude,
  reason,
});
export const STORAGE_EXPORT_INTERNALS = [
  internal(
    'storage_protocols',
    [
      'bucket',
      'generation',
      'endpoint_fingerprint',
      'provider_verified_at',
      'provider_report',
      'baseline_at',
      'created_at',
    ],
    'Provider-wide verification evidence',
  ),
  internal(
    'storage_inventory_runs',
    ['id', 'bucket', 'generation', 'state', 'cursor', 'error', 'created_at', 'completed_at'],
    'Provider-wide inventory operations',
  ),
  internal(
    'storage_inventory_objects',
    ['run_id', 'object_key', 'bytes', 'etag', 'content_type', 'closure_nonce'],
    'Other owners and provider-wide object evidence',
  ),
  internal(
    'storage_migration_bindings',
    [
      'id',
      'bucket',
      'source_key',
      'blip_id',
      'generation',
      'owner_id',
      'radar_id',
      'destination_key',
      'source_etag',
      'source_bytes',
      'source_content_type',
      'state',
      'created_at',
      'completed_at',
    ],
    'Internal migration attempts; current owned content is exported separately',
  ),
];
export const GUEST_EXPORT_INTERNALS = [
  internal(
    'guest_support_capabilities',
    [
      'id',
      'radar_id',
      'owner_id',
      'token_hash',
      'recovery_hash',
      'created_at',
      'expires_at',
      'revoked_at',
    ],
    'Guest credentials, not account identity',
  ),
  internal(
    'guest_support_operations',
    ['capability_id', 'operation_id', 'payload_hash', 'request_id', 'created_at'],
    'Guest replay and capability internals',
  ),
  internal(
    'guest_support_limits',
    ['key', 'window_started_at', 'count'],
    'Guest antiabuse and network hashes',
  ),
];
export const STORAGE_EXPORT_HISTORY = ['protocol_generation', 'released_at', 'retired_at'];
export const STORAGE_EXPORT_PRIVATE = ['tombstone_nonce', 'migrated_to', 'migration_source_etag'];
export const FINANCIAL_EXPORT_OBSERVATIONS: ExportTablePolicy = {
  table: 'billing_financial_observations',
  include: [],
  exclude: [
    'id',
    'user_id',
    'mode',
    'contract_id',
    'summary',
    'observed_at',
    'stripe_account_id',
    'subscription_id',
    'invoice_id',
    'digest',
    'facts',
  ],
  reason: 'Retired billing history: kept in the database, no longer part of the account',
};

export const BUILDER_EXPORT_INTERNALS = [
  internal(
    'plan_catalog_plan_ids',
    ['id', 'first_revision'],
    'Global permanent plan references; owned purchased terms are projected separately',
  ),
];
export const FEATURE_EXPORT_INTERNALS = [
  internal(
    'plan_feature_terms',
    ['catalog_revision', 'plan_id', 'features'],
    'Global feature agreements; only the requester’s purchased version is projected',
  ),
];

export const CLOSURE_EXPORT_POLICIES: readonly ExportTablePolicy[] = [
  {
    table: 'account_closure_requests',
    include: ['id', 'user_id', 'requested_at', 'phase'],
    exclude: ['confirmed_session_id', 'billing_snapshot'],
    where: 'r.user_id = $1',
    reason: 'Your access-closure request status, not private confirmation or billing evidence',
  },
  internal(
    'account_closure_challenges',
    [
      'user_id',
      'id',
      'session_id',
      'code_hash',
      'expires_at',
      'attempts',
      'consumed_at',
      'created_at',
      'window_started_at',
      'window_count',
    ],
    'One-use closure confirmation secrets and abuse controls',
  ),
  internal('account_lifecycle_fences', ['user_id'], 'Internal account lifecycle locking'),
];

export function accountExportPolicies(
  columns: readonly { table: string; column: string }[],
): readonly ExportTablePolicy[] {
  const storage = columns.some(
    (c) =>
      c.table === 'storage_protocols' ||
      (c.table === 'storage_objects' && c.column === 'protocol_generation'),
  );
  const guest = columns.some(
    (c) =>
      c.table === 'guest_support_capabilities' ||
      (c.table === 'helpdesk_requests' && c.column === 'guest_capability_id'),
  );
  const financial = columns.some(
    (c) =>
      c.table === 'billing_financial_observations' ||
      (c.table === 'billing_accounts' && c.column === 'financial_attention') ||
      (c.table === 'billing_events' && c.column === 'object_id'),
  );
  const builder = columns.some(
    (c) =>
      c.table === 'plan_catalog_plan_ids' ||
      (c.table === 'plan_catalog_revisions' &&
        ['format_version', 'baseline_plan_id'].includes(c.column)) ||
      (c.table === 'billing_contracts' && c.column === 'option_id'),
  );
  const principals = columns.some(
    (c) =>
      c.table === 'notifications' && ['actor_keys', 'attributed_event_count'].includes(c.column),
  );
  const features = columns.some((c) => c.table === 'plan_feature_terms');
  const closure = columns.some((c) => CLOSURE_EXPORT_POLICIES.some((p) => p.table === c.table));
  if (features && !builder)
    throw new Error('Account export feature generation lacks its builder schema');
  return [
    ...ACCOUNT_EXPORT_TABLES.map((p) => {
      if (storage && p.table === 'storage_objects')
        return {
          ...p,
          include: [...p.include, ...STORAGE_EXPORT_HISTORY],
          exclude: [...p.exclude, ...STORAGE_EXPORT_PRIVATE],
        };
      if (guest && p.table === 'helpdesk_requests')
        return {
          ...p,
          exclude: [...p.exclude, 'guest_capability_id'],
        };
      if (financial && p.table === 'billing_accounts')
        return { ...p, exclude: [...p.exclude, 'financial_attention'] };
      if (financial && p.table === 'billing_events')
        return { ...p, exclude: [...p.exclude, 'object_id'] };
      if (builder && p.table === 'plan_catalog_revisions')
        return { ...p, exclude: [...p.exclude, 'format_version', 'baseline_plan_id'] };
      if (builder && p.table === 'billing_contracts')
        return { ...p, exclude: [...p.exclude, 'option_id'] };
      if (principals && p.table === 'notifications')
        return { ...p, exclude: [...p.exclude, 'actor_keys', 'attributed_event_count'] };
      return p;
    }),
    ...(storage ? STORAGE_EXPORT_INTERNALS : []),
    ...(guest ? GUEST_EXPORT_INTERNALS : []),
    ...(financial ? [FINANCIAL_EXPORT_OBSERVATIONS] : []),
    ...(builder ? BUILDER_EXPORT_INTERNALS : []),
    ...(features ? FEATURE_EXPORT_INTERNALS : []),
    ...(closure ? CLOSURE_EXPORT_POLICIES : []),
  ];
}
