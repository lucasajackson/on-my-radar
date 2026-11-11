/**
 * The account settings sections, each its own URL under /settings.
 *
 * Settings used to be one page holding all of these, and links into it were
 * fragments (`/settings#email-capture`). Those links are in emails and in
 * people's bookmarks, so `legacySettingsTarget` keeps every one of them working.
 */
export const SETTINGS_SECTIONS = [
  { key: 'profile', label: 'Profile', hint: 'Name, appearance and sign out' },
  { key: 'notifications', label: 'Notifications', hint: 'Email, push and per-radar alerts' },
  { key: 'connections', label: 'Connections', hint: 'AI agents (MCP), tokens and apps' },
  { key: 'email', label: 'Email capture', hint: 'Your capture address' },
  { key: 'data', label: 'Data', hint: 'Download your account as a .zip' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['key'];
export type SettingsPath = `/settings/${SettingsSection}`;

export const settingsPath = (key: SettingsSection): SettingsPath => `/settings/${key}`;

/** The section a path is in, or null for the /settings root itself. */
export function sectionForPath(pathname: string): SettingsSection | null {
  const key = /^\/settings\/([^/]+)\/?$/.exec(pathname)?.[1];
  return SETTINGS_SECTIONS.find((section) => section.key === key)?.key ?? null;
}

const LEGACY_FRAGMENTS: Record<string, { section: SettingsSection }> = {
  profile: { section: 'profile' },
  appearance: { section: 'profile' },
  notifications: { section: 'notifications' },
  connections: { section: 'connections' },
  tokens: { section: 'connections' },
  integrations: { section: 'connections' },
  'email-capture': { section: 'email' },
  download: { section: 'data' },
  export: { section: 'data' },
  data: { section: 'data' },
};

/** Where a link written for the single settings page belongs now, or null when it is current. */
export function legacySettingsTarget(pathname: string, hash: string): { to: SettingsPath } | null {
  if (pathname.replace(/\/$/, '') !== '/settings') return null;
  const fragment = LEGACY_FRAGMENTS[hash.replace(/^#/, '')];
  return fragment ? { to: settingsPath(fragment.section) } : null;
}
