-- No access revocation policy is implied by an observed refund, credit or dispute.
ALTER TABLE billing_accounts ADD COLUMN financial_attention boolean NOT NULL DEFAULT false;
ALTER TABLE billing_events ADD COLUMN object_id text;
CREATE TABLE billing_financial_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('sandbox', 'live')),
  contract_id uuid NOT NULL,
  stripe_account_id text NOT NULL,
  subscription_id text NOT NULL,
  invoice_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id, mode, contract_id) REFERENCES billing_contracts(user_id, mode, id)
);
CREATE INDEX billing_financial_invoice_history ON billing_financial_observations(mode, stripe_account_id, invoice_id, observed_at DESC, id);
CREATE INDEX billing_financial_owner_history ON billing_financial_observations(user_id, mode, observed_at DESC, id);
CREATE FUNCTION omr_billing_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Financial observations are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM billing_contracts WHERE id = NEW.contract_id
    AND user_id = NEW.user_id AND mode = NEW.mode AND stripe_account_id = NEW.stripe_account_id) THEN
    RAISE EXCEPTION 'Financial observation account or contract mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_financial_observations WHERE mode = NEW.mode
    AND stripe_account_id = NEW.stripe_account_id AND invoice_id = NEW.invoice_id
    AND (user_id <> NEW.user_id OR contract_id <> NEW.contract_id OR subscription_id <> NEW.subscription_id)) THEN
    RAISE EXCEPTION 'Financial invoice binding cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_financial_immutable BEFORE INSERT OR UPDATE OR DELETE ON billing_financial_observations
FOR EACH ROW EXECUTE FUNCTION omr_billing_financial_immutable();
