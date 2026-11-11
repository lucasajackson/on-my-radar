-- Companion feature terms preserve historical format1/2 pricing and contracts.
CREATE FUNCTION omr_companion_features_valid(body jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE t jsonb; seen text[] := '{}';
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR NOT body ?& ARRAY['version','templates','mcp']
     OR body - ARRAY['version','templates','mcp'] <> '{}'::jsonb
     OR body->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(body->'mcp') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(body->'templates') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'templates')>6 THEN RETURN false; END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(body->'templates') LOOP
    IF jsonb_typeof(t) IS DISTINCT FROM 'string' OR t #>> '{}' NOT IN ('stream','kanban','microblog','reading','decisions','discussion')
       OR (t #>> '{}') = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen,t #>> '{}');
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE plan_feature_terms (
  catalog_revision integer NOT NULL REFERENCES plan_catalog_revisions(revision),
  plan_id text NOT NULL REFERENCES plan_catalog_plan_ids(id),
  features jsonb NOT NULL CHECK (omr_companion_features_valid(features) IS TRUE),
  PRIMARY KEY(catalog_revision,plan_id)
);
CREATE FUNCTION omr_companion_terms_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE catalog record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('plan-catalog',0));
  SELECT * INTO catalog FROM plan_catalog_revisions WHERE revision=NEW.catalog_revision FOR UPDATE;
  IF catalog.state IS DISTINCT FROM 'draft' OR catalog.format_version IS DISTINCT FROM 2
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalog.plans) p WHERE p->>'id'=NEW.plan_id) THEN
    RAISE EXCEPTION 'Feature terms require this saved format2 draft plan'; END IF;
  IF NEW.plan_id=catalog.baseline_plan_id AND NOT (NEW.features->'templates' @> '["stream"]'::jsonb) THEN
    RAISE EXCEPTION 'The default free plan must include Stream'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER companion_terms_insert BEFORE INSERT ON plan_feature_terms FOR EACH ROW EXECUTE FUNCTION omr_companion_terms_insert();
CREATE FUNCTION omr_companion_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published-version feature terms are immutable'; END $$;
CREATE TRIGGER companion_terms_immutable BEFORE UPDATE OR DELETE ON plan_feature_terms FOR EACH ROW EXECUTE FUNCTION omr_companion_terms_immutable();
CREATE FUNCTION omr_companion_terms_publish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='draft' AND NEW.state IN ('proposed','active') THEN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plans) p
      WHERE EXISTS(SELECT 1 FROM plan_feature_terms old_term WHERE old_term.plan_id=p->>'id' AND old_term.catalog_revision<NEW.revision)
      AND NOT EXISTS(SELECT 1 FROM plan_feature_terms new_term WHERE new_term.catalog_revision=NEW.revision AND new_term.plan_id=p->>'id')) THEN
      RAISE EXCEPTION 'Explicit feature terms cannot become unspecified'; END IF;
    IF NEW.state='active' AND EXISTS(SELECT 1 FROM plan_feature_terms WHERE catalog_revision=NEW.revision)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plans) p WHERE p->>'status'='offered'
        AND NOT EXISTS(SELECT 1 FROM plan_feature_terms t WHERE t.catalog_revision=NEW.revision AND t.plan_id=p->>'id')) THEN
      RAISE EXCEPTION 'Set feature access for every offered plan'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER companion_terms_publish BEFORE UPDATE ON plan_catalog_revisions FOR EACH ROW EXECUTE FUNCTION omr_companion_terms_publish();
