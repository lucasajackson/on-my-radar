-- Decision requests (collaboration slice D1): an agent asks a person to decide something on a
-- card, and the activity list splits into "Needs you" and "Agents reported".
--
-- Universal, like a comment: any card can carry one. What an answer does is declared by the radar's
-- template (`decides`), so `template` and `lane` record where the question was asked: a card that
-- later moves lane, or a radar whose template changes, reads the request as overtaken (computed,
-- never stored). The request is read only while `radar_id` still equals the blip's radar, so a
-- card moved elsewhere takes nothing of this one with it.
--
-- Rolling-safe: a new table nothing old reads or writes. The previous image renders the new
-- notification kinds as a neutral line (an unknown kind is not an error).
-- Rollback: DROP TABLE decision_requests.
CREATE TABLE decision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blip_id uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  -- SET NULL and deferred, like every authorship FK (deleting one person fires several actions).
  requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  requester_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  addressee_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  context text NOT NULL,
  question text NOT NULL,
  options text[] NOT NULL DEFAULT ARRAY[]::text[],
  template text NOT NULL,
  lane text,
  status text NOT NULL DEFAULT 'open',
  answer text,
  answered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_requests_context_line CHECK (char_length(context) BETWEEN 1 AND 200 AND context !~ '[\r\n]'),
  CONSTRAINT decision_requests_status_valid CHECK (status IN ('open', 'answered')),
  CONSTRAINT decision_requests_answered CHECK ((status = 'answered') = (answer IS NOT NULL AND answered_at IS NOT NULL))
);
CREATE INDEX decision_requests_blip_idx ON decision_requests (blip_id);
CREATE INDEX decision_requests_radar_idx ON decision_requests (radar_id);
CREATE INDEX decision_requests_requester_open_idx ON decision_requests (requester_user_id, requester_agent_id) WHERE status = 'open';
CREATE INDEX decision_requests_addressee_idx ON decision_requests (addressee_user_id) WHERE addressee_user_id IS NOT NULL;
CREATE INDEX decision_requests_requester_agent_idx ON decision_requests (requester_agent_id) WHERE requester_agent_id IS NOT NULL;
CREATE INDEX decision_requests_answerer_idx ON decision_requests (answered_by_user_id) WHERE answered_by_user_id IS NOT NULL;

-- A closing account admits no new requests (0057). INSERT only: the SET NULL that deleting a person
-- performs is an UPDATE and must not be refused.
CREATE TRIGGER account_closure_writer BEFORE INSERT ON decision_requests
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard();
