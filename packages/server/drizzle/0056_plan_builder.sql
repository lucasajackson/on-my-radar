-- Historical format1 bodies and contracts are untouched. New catalogs use ordered plan options.
ALTER TABLE plan_catalog_revisions
  ADD COLUMN format_version integer NOT NULL DEFAULT 1 CHECK (format_version IN (1,2)),
  ADD COLUMN baseline_plan_id text;
ALTER TABLE plan_catalog_revisions DROP CONSTRAINT plan_catalog_revisions_plans_check;
CREATE TABLE plan_catalog_plan_ids (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{2,63}$' AND id NOT IN ('legacy','unavailable')),
  first_revision integer NOT NULL REFERENCES plan_catalog_revisions(revision)
);
INSERT INTO plan_catalog_plan_ids(id, first_revision)
SELECT p->>'id', min(revision) FROM plan_catalog_revisions, LATERAL jsonb_array_elements(plans) p GROUP BY p->>'id';
CREATE FUNCTION omr_plan_reference_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Permanent plan references cannot be changed or deleted'; END $$;
CREATE TRIGGER plan_reference_immutable BEFORE UPDATE OR DELETE ON plan_catalog_plan_ids
FOR EACH ROW EXECUTE FUNCTION omr_plan_reference_immutable();

CREATE FUNCTION omr_builder_catalog_valid(body jsonb, baseline text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb; o jsonb; lim jsonb; mode text; ids text[] := '{}'; prices_sandbox text[] := '{}'; prices_live text[] := '{}'; option_ids text[]; free_count integer := 0; price text; n numeric;
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'array' OR jsonb_array_length(body) NOT BETWEEN 1 AND 100 OR baseline IS NULL THEN RETURN false; END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(body) LOOP
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['id','name','status','limits','options'] OR p - ARRAY['id','name','status','limits','options'] <> '{}'::jsonb
       OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR p->>'id' !~ '^[a-z][a-z0-9_-]{2,63}$' OR p->>'id' IN ('legacy','unavailable') OR p->>'id' = ANY(ids)
       OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR length(btrim(p->>'name')) NOT BETWEEN 1 AND 60
       OR p->>'status' NOT IN ('offered','retired') OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    ids := array_append(ids,p->>'id'); lim := p->'limits';
    IF jsonb_typeof(lim) IS DISTINCT FROM 'object' OR NOT lim ?& ARRAY['radars','agents','storageBytes'] OR lim - ARRAY['radars','agents','storageBytes'] <> '{}'::jsonb THEN RETURN false; END IF;
    FOR mode IN SELECT unnest(ARRAY['radars','agents','storageBytes']) LOOP
      IF lim->mode = 'null'::jsonb AND mode <> 'storageBytes' THEN CONTINUE; END IF;
      IF jsonb_typeof(lim->mode) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      n := (lim->>mode)::numeric;
      IF n <> trunc(n) OR n < (CASE WHEN mode='radars' THEN 1 ELSE 0 END) OR n > (CASE mode WHEN 'radars' THEN 100000 WHEN 'agents' THEN 100 ELSE 9007199254740991 END) THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(p->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'options') NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
    option_ids := '{}';
    FOR o IN SELECT value FROM jsonb_array_elements(p->'options') LOOP
      IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT o ?& ARRAY['id','amount','currency','interval','stripePrices'] OR o - ARRAY['id','amount','currency','interval','stripePrices'] <> '{}'::jsonb
         OR o->>'id' NOT IN ('free','monthly','annual') OR jsonb_typeof(o->'id') IS DISTINCT FROM 'string' OR o->>'id' = ANY(option_ids)
         OR o->>'currency' IS DISTINCT FROM 'usd' OR jsonb_typeof(o->'amount') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      option_ids := array_append(option_ids,o->>'id'); n := (o->>'amount')::numeric;
      IF n <> trunc(n) OR n NOT BETWEEN 0 AND 1000000 THEN RETURN false; END IF;
      IF jsonb_typeof(o->'stripePrices') IS DISTINCT FROM 'object' OR NOT (o->'stripePrices') ?& ARRAY['sandbox','live'] OR (o->'stripePrices') - ARRAY['sandbox','live'] <> '{}'::jsonb THEN RETURN false; END IF;
      FOR mode IN SELECT unnest(ARRAY['sandbox','live']) LOOP
        price := o->'stripePrices'->>mode;
        IF price IS NOT NULL AND (jsonb_typeof(o->'stripePrices'->mode) IS DISTINCT FROM 'string' OR price !~ '^price_[A-Za-z0-9]+$') THEN RETURN false; END IF;
        IF price IS NOT NULL THEN
          IF mode='sandbox' THEN IF price = ANY(prices_sandbox) THEN RETURN false; END IF; prices_sandbox := array_append(prices_sandbox,price);
          ELSE IF price = ANY(prices_live) THEN RETURN false; END IF; prices_live := array_append(prices_live,price); END IF;
        END IF;
      END LOOP;
      IF o->>'id'='free' THEN
        IF n <> 0 OR o->'interval' <> 'null'::jsonb OR o->'stripePrices'->'sandbox' <> 'null'::jsonb OR o->'stripePrices'->'live' <> 'null'::jsonb OR jsonb_array_length(p->'options') <> 1 THEN RETURN false; END IF;
        IF p->>'status'='offered' THEN free_count := free_count+1; IF p->>'id' <> baseline THEN RETURN false; END IF; END IF;
      ELSIF n <= 0 OR o->>'interval' IS DISTINCT FROM (CASE WHEN o->>'id'='monthly' THEN 'month' ELSE 'year' END) THEN RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN free_count=1;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE plan_catalog_revisions ADD CONSTRAINT plan_catalog_format_check CHECK (
  (format_version=1 AND baseline_plan_id IS NULL AND jsonb_typeof(plans)='array' AND jsonb_array_length(plans)=3)
  OR (format_version=2 AND omr_builder_catalog_valid(plans,baseline_plan_id))
);
CREATE FUNCTION omr_plan_catalog_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest record; p jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('plan-catalog',0));
  SELECT * INTO latest FROM plan_catalog_revisions ORDER BY revision DESC LIMIT 1;
  IF latest.format_version=2 AND NEW.format_version<>2 THEN RAISE EXCEPTION 'Catalog format cannot be downgraded'; END IF;
  IF NEW.format_version=2 THEN
    FOR p IN SELECT value FROM jsonb_array_elements(NEW.plans) LOOP
      IF EXISTS(SELECT 1 FROM plan_catalog_plan_ids WHERE id=p->>'id') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(latest.plans) history_plan WHERE history_plan->>'id'=p->>'id') THEN
        RAISE EXCEPTION 'A removed permanent plan reference cannot be reused';
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM plan_catalog_revisions r, LATERAL jsonb_array_elements(r.plans) published_plan WHERE r.state<>'draft' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plans) proposed_plan WHERE proposed_plan->>'id'=published_plan->>'id')) THEN
      RAISE EXCEPTION 'Published plans must be retained as retired';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_catalog_insert BEFORE INSERT ON plan_catalog_revisions FOR EACH ROW EXECUTE FUNCTION omr_plan_catalog_insert();
CREATE FUNCTION omr_plan_catalog_register() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO plan_catalog_plan_ids(id,first_revision) SELECT p->>'id',NEW.revision FROM jsonb_array_elements(NEW.plans) p ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_catalog_register AFTER INSERT ON plan_catalog_revisions FOR EACH ROW EXECUTE FUNCTION omr_plan_catalog_register();
CREATE OR REPLACE FUNCTION omr_plan_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Plan catalog history cannot be deleted'; END IF;
  IF OLD.state<>'draft' OR NEW.revision<>OLD.revision OR NEW.plans<>OLD.plans OR NEW.created_at<>OLD.created_at OR NEW.state='draft'
     OR NEW.format_version<>OLD.format_version OR NEW.baseline_plan_id IS DISTINCT FROM OLD.baseline_plan_id THEN RAISE EXCEPTION 'Plan catalog revisions are immutable'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE billing_contracts ADD COLUMN option_id text CHECK (option_id IN ('free','monthly','annual'));
ALTER TABLE billing_contracts DROP CONSTRAINT billing_contracts_plan_id_check;
ALTER TABLE billing_contracts DROP CONSTRAINT billing_contracts_check;
ALTER TABLE billing_contracts DROP CONSTRAINT billing_contracts_check1;
ALTER TABLE billing_contracts ADD CONSTRAINT billing_contract_provider_pair CHECK ((stripe_price_id IS NULL)=(stripe_account_id IS NULL));
ALTER TABLE billing_contracts ADD CONSTRAINT billing_contract_plan_reference FOREIGN KEY(plan_id) REFERENCES plan_catalog_plan_ids(id);
CREATE OR REPLACE FUNCTION omr_billing_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE catalog_state text; fmt integer; baseline text; plan jsonb; option jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Purchased contracts are immutable'; END IF;
  SELECT state,format_version,baseline_plan_id,p INTO catalog_state,fmt,baseline,plan FROM plan_catalog_revisions,LATERAL jsonb_array_elements(plans) p WHERE revision=NEW.catalog_revision AND p->>'id'=NEW.plan_id;
  IF catalog_state IS DISTINCT FROM 'active' OR plan IS NULL OR plan->'limits'->>'radars' IS NULL OR plan->'limits'->>'agents' IS NULL THEN RAISE EXCEPTION 'Contract must bind a complete active catalog plan'; END IF;
  IF fmt=1 THEN
    IF NEW.option_id IS NOT NULL OR NEW.plan_id NOT IN ('social','collaboration','agent') OR (NEW.plan_id='social') IS DISTINCT FROM (NEW.stripe_price_id IS NULL) OR (NEW.plan_id='social') IS DISTINCT FROM (NEW.stripe_account_id IS NULL)
       OR (NEW.plan_id<>'social' AND (plan->'stripePrices'->>NEW.mode IS DISTINCT FROM NEW.stripe_price_id OR NEW.stripe_price_id IS NULL OR NEW.stripe_price_id !~ '^price_[A-Za-z0-9]+$' OR NEW.stripe_account_id IS NULL OR NEW.stripe_account_id !~ '^acct_[A-Za-z0-9]+$')) THEN RAISE EXCEPTION 'Invalid historical contract binding'; END IF;
  ELSE
    SELECT o INTO option FROM jsonb_array_elements(plan->'options') o WHERE o->>'id'=NEW.option_id;
    IF option IS NULL OR plan->>'status' IS DISTINCT FROM 'offered' THEN RAISE EXCEPTION 'Contract must select an offered historical option'; END IF;
    IF option->>'id'='free' THEN
      IF NEW.plan_id IS DISTINCT FROM baseline OR NEW.stripe_price_id IS NOT NULL OR NEW.stripe_account_id IS NOT NULL THEN RAISE EXCEPTION 'Free contract requires the historical baseline and no provider binding'; END IF;
    ELSIF NEW.stripe_price_id IS NULL OR NEW.stripe_account_id IS NULL OR option->'stripePrices'->>NEW.mode IS DISTINCT FROM NEW.stripe_price_id OR NEW.stripe_price_id !~ '^price_[A-Za-z0-9]+$' OR NEW.stripe_account_id !~ '^acct_[A-Za-z0-9]+$' THEN RAISE EXCEPTION 'Contract price must match the historical selected option and environment'; END IF;
  END IF;
  RETURN NEW;
END $$;
