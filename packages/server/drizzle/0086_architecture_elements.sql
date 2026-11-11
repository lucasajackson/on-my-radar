-- Architecture radar, slice 2: boundaries and contracts are blips in their own
-- lanes; these tables hold what only they have.

-- Links between blips. `seam_side`: a contract joins a boundary on side a or b.
-- `amends`: an ADR amends a boundary or a contract. `to_blip_id` is NO ACTION
-- (not RESTRICT, not CASCADE): the database refuses to delete a boundary that
-- still has seams, and deleting a radar still cascades through radar_id.
CREATE TABLE blip_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES radars (id) ON DELETE CASCADE,
  from_blip_id uuid NOT NULL REFERENCES blips (id) ON DELETE CASCADE,
  to_blip_id uuid NOT NULL REFERENCES blips (id) ON DELETE NO ACTION,
  kind text NOT NULL CHECK (kind IN ('seam_side', 'amends')),
  side text CHECK (side IN ('a', 'b')),
  CHECK (from_blip_id <> to_blip_id),
  CHECK ((kind = 'seam_side') = (side IS NOT NULL)),
  UNIQUE (from_blip_id, kind, side),
  UNIQUE (from_blip_id, to_blip_id, kind)
);
CREATE INDEX blip_relations_radar_idx ON blip_relations (radar_id);
CREATE INDEX blip_relations_to_idx ON blip_relations (to_blip_id);

-- Node attributes. A boundary with no seams has no relation row to hang them on.
CREATE TABLE blip_elements (
  blip_id uuid PRIMARY KEY REFERENCES blips (id) ON DELETE CASCADE,
  external boolean NOT NULL DEFAULT false,
  owns text[] NOT NULL DEFAULT '{}',
  version text,
  -- Copied from the blip by the trigger below, so the unique index can be scoped
  -- to element blips: a lane id alone says nothing (a Kanban radar may name a
  -- custom lane "contract").
  radar_id uuid NOT NULL,
  lane text NOT NULL,
  title_key text NOT NULL,
  CHECK (cardinality(owns) <= 100),
  CHECK (char_length(version) <= 32)
);

CREATE FUNCTION blip_elements_fill() RETURNS trigger AS $$
BEGIN
  SELECT radar_id, status, lower(title) INTO NEW.radar_id, NEW.lane, NEW.title_key
    FROM blips WHERE id = NEW.blip_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER blip_elements_fill BEFORE INSERT ON blip_elements
  FOR EACH ROW EXECUTE FUNCTION blip_elements_fill();

CREATE FUNCTION blip_elements_retitle() RETURNS trigger AS $$
BEGIN
  UPDATE blip_elements SET title_key = lower(NEW.title) WHERE blip_id = NEW.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER blip_elements_retitle AFTER UPDATE OF title ON blips
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title)
  EXECUTE FUNCTION blip_elements_retitle();

-- One boundary (or contract) per title on a radar, whatever the case. The index
-- arbitrates concurrent upserts of the same title; it covers element rows only.
CREATE UNIQUE INDEX blips_element_title_key ON blip_elements (radar_id, lane, title_key);
