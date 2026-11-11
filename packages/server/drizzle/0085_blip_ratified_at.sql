-- When a blip entered its template's ratified lane (an ADR becoming Accepted).
-- An event time nothing else records; the architecture ledger is ordered by it.
ALTER TABLE blips ADD COLUMN ratified_at timestamptz;
