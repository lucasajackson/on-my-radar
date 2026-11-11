-- Immutable purchases reference the immutable catalog; no existing account is relabelled.
CREATE TABLE billing_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('sandbox', 'live')),
  catalog_revision integer NOT NULL REFERENCES plan_catalog_revisions(revision),
  plan_id text NOT NULL CHECK (plan_id IN ('social','collaboration','agent')),
  stripe_price_id text,
  stripe_account_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, mode, id),
  CHECK ((plan_id = 'social') = (stripe_price_id IS NULL)),
  CHECK ((plan_id = 'social') = (stripe_account_id IS NULL))
);
CREATE FUNCTION omr_billing_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE catalog_state text; plan jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Purchased contracts are immutable'; END IF;
  SELECT state, p INTO catalog_state, plan FROM plan_catalog_revisions,
    LATERAL jsonb_array_elements(plans) p
    WHERE revision = NEW.catalog_revision AND p->>'id' = NEW.plan_id;
  IF catalog_state IS DISTINCT FROM 'active' OR plan IS NULL
     OR plan->'limits'->>'radars' IS NULL OR plan->'limits'->>'agents' IS NULL
     OR (NEW.plan_id <> 'social' AND
         (plan->'stripePrices'->>NEW.mode IS DISTINCT FROM NEW.stripe_price_id
          OR NEW.stripe_price_id !~ '^price_[A-Za-z0-9]+$'
          OR NEW.stripe_account_id !~ '^acct_[A-Za-z0-9]+$')) THEN
    RAISE EXCEPTION 'Contract must bind a complete active catalog plan';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_contract_immutable BEFORE INSERT OR UPDATE OR DELETE ON billing_contracts
FOR EACH ROW EXECUTE FUNCTION omr_billing_contract_immutable();
ALTER TABLE billing_accounts
  ADD COLUMN free_contract_id uuid,
  ADD COLUMN checkout_contract_id uuid,
  ADD COLUMN subscription_contract_id uuid,
  ADD FOREIGN KEY (user_id, mode, free_contract_id) REFERENCES billing_contracts(user_id, mode, id),
  ADD FOREIGN KEY (user_id, mode, checkout_contract_id) REFERENCES billing_contracts(user_id, mode, id),
  ADD FOREIGN KEY (user_id, mode, subscription_contract_id) REFERENCES billing_contracts(user_id, mode, id);
