-- Commercial terms are immutable snapshots, separate from editable marketing copy.
CREATE TABLE plan_catalog_revisions (
  revision integer PRIMARY KEY CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft', 'proposed', 'active')),
  plans jsonb NOT NULL CHECK (jsonb_typeof(plans) = 'array' AND jsonb_array_length(plans) = 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK ((state = 'draft') = (published_at IS NULL))
);
CREATE FUNCTION omr_plan_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Plan catalog history cannot be deleted'; END IF;
  IF OLD.state <> 'draft' OR NEW.revision <> OLD.revision OR NEW.plans <> OLD.plans
     OR NEW.created_at <> OLD.created_at OR NEW.state = 'draft' THEN
    RAISE EXCEPTION 'Plan catalog revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_catalog_immutable BEFORE UPDATE OR DELETE ON plan_catalog_revisions
FOR EACH ROW EXECUTE FUNCTION omr_plan_catalog_immutable();
INSERT INTO plan_catalog_revisions(revision, state, plans, published_at)
VALUES (1, 'proposed', '[{"id": "social", "name": "Social", "amount": 0, "currency": "usd", "interval": "month", "limits": {"radars": null, "agents": null, "storageBytes": 104857600}, "stripePrices": {"sandbox": null, "live": null}}, {"id": "collaboration", "name": "Collaboration", "amount": 500, "currency": "usd", "interval": "month", "limits": {"radars": null, "agents": null, "storageBytes": 1073741824}, "stripePrices": {"sandbox": null, "live": null}}, {"id": "agent", "name": "Agent", "amount": 1000, "currency": "usd", "interval": "month", "limits": {"radars": null, "agents": null, "storageBytes": 5368709120}, "stripePrices": {"sandbox": null, "live": null}}]'::jsonb, now());
