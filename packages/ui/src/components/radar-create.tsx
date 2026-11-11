import { Select } from './select';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  DEFAULT_RADAR_ACCENT,
  DEFAULT_RADAR_GLYPH,
  RADAR_TEMPLATES,
  RADAR_TEMPLATE_IDS,
  type RadarDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { Modal, notify } from './primitives';
import { AppearancePicker } from './appearance';
import { TopicPicker } from './topic-dialogs';

export function NewRadarDialog({
  initialTopicId = null,
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (radar: RadarDto) => void;
  initialTopicId?: string | null;
}) {
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [topicId, setTopicId] = useState<string | null>(initialTopicId);
  const [accent, setAccent] = useState<string>(DEFAULT_RADAR_ACCENT);
  const [glyph, setGlyph] = useState<string>(DEFAULT_RADAR_GLYPH);
  const [template, setTemplate] = useState<string>('stream');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const { radar } = await api.radars.create({
        name: name.trim(),
        tagline,
        ...(topicId ? { topicId } : {}),
        accent,
        glyph,
        template,
      });
      onCreated(radar);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the radar', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New radar"
      description="Everything you capture about one thing, in one place."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            <Plus className="h-4 w-4" />
            {busy ? 'Creating…' : 'Create radar'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Name</span>
          <input
            className="field"
            value={name}
            autoFocus
            placeholder="New app ideas"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Tagline</span>
          <input
            className="field"
            value={tagline}
            placeholder="Optional — what belongs here?"
            onChange={(e) => setTagline(e.target.value)}
          />
        </label>
        <TopicPicker topicId={topicId} onChange={setTopicId} />
        <label className="flex flex-col gap-2">
          <span className="instrument">Layout</span>
          <Select
            className="field"
            value={template}
            onValueChange={(value) => setTemplate(value)}
            options={RADAR_TEMPLATE_IDS.map((key) => ({
              value: key,
              label: RADAR_TEMPLATES[key].label,
            }))}
          />
          <span className="note">
            {RADAR_TEMPLATES[template as keyof typeof RADAR_TEMPLATES].blurb}
          </span>
          <span className="note">You can change the layout later in radar settings.</span>
        </label>

        <AppearancePicker
          accent={accent}
          glyph={glyph}
          onAccent={setAccent}
          onGlyph={setGlyph}
          label="Look"
        />
      </div>
    </Modal>
  );
}
