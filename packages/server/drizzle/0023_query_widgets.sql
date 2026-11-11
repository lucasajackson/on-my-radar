-- Query widgets reference their authorized search expression, not one anchor radar.
-- Existing radar widgets retain the original foreign-key/cascade behavior.
-- Old configuration was an opaque bag with no implemented reading behavior.
-- Normalize it before introducing a typed discriminator, including arbitrary
-- legacy `type` keys accepted by the previous public API.
UPDATE dashboard_widgets SET config = '{}'::jsonb WHERE radar_id IS NOT NULL;
ALTER TABLE dashboard_widgets ALTER COLUMN radar_id DROP NOT NULL;
ALTER TABLE dashboard_widgets ADD CONSTRAINT dashboard_widget_source_check
  CHECK (
    (COALESCE(config->>'type', 'radar') = 'query' AND radar_id IS NULL)
    OR (COALESCE(config->>'type', 'radar') = 'radar' AND radar_id IS NOT NULL)
  );
