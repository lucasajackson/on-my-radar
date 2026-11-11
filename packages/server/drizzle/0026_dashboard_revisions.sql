-- Complete replacements must name the revision they observed. Incremented under
-- the same dashboard row lock as all partial layout and metadata changes.
ALTER TABLE dashboards ADD COLUMN revision integer NOT NULL DEFAULT 0;
