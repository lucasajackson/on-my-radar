export const RADAR_SETTINGS_SECTIONS = [
  'identity',
  'appearance',
  'people',
  'sources',
  'webhooks',
  'portal',
] as const;
export type RadarSettingsSection = (typeof RADAR_SETTINGS_SECTIONS)[number];
