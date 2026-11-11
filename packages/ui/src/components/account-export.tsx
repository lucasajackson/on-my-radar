import { useEffect, useRef, useState } from 'react';
import { Section } from './primitives';
import { downloadAccount, type ExportProgress } from '../lib/account-export';

export function AccountExport() {
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'failed'>('idle');
  const [progress, setProgress] = useState<ExportProgress>({ files: 0, bytes: 0 });
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function start() {
    const current = new AbortController();
    controller.current = current;
    setStatus('running');
    setError('');
    setProgress({ files: 0, bytes: 0 });
    const deadline = setTimeout(() => current.abort(), 30 * 60_000);
    try {
      await downloadAccount(current.signal, setProgress);
      setStatus('complete');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The account download failed.');
      setStatus('failed');
    } finally {
      clearTimeout(deadline);
      controller.current = null;
    }
  }
  return (
    <Section title="Download your account">
      <p className="text-sm text-[var(--muted)]">
        A .zip of everything you have captured: one folder per radar with each blip as a text file
        you can open anywhere, the files attached to them, and a complete copy of your data for
        other apps. Shared radars are included while you can read them. Permanently removed content
        cannot be recovered.
      </p>
      <p className="text-sm text-[var(--muted)]">
        Keep this page open until the download finishes. Large accounts can take a while.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn" disabled={status === 'running'} onClick={() => void start()}>
          {status === 'running' ? 'Preparing download…' : 'Download .zip'}
        </button>
        {status === 'running' ? (
          <button className="btn" onClick={() => controller.current?.abort()}>
            Cancel
          </button>
        ) : null}
      </div>
      <p className="text-sm" role={status === 'failed' ? 'alert' : 'status'}>
        {status === 'running'
          ? `${progress.files} files · ${(progress.bytes / 1024 ** 2).toFixed(1)} MB prepared`
          : status === 'complete'
            ? 'Done. Check your browser’s downloads for On-My-Radar-account.zip.'
            : status === 'failed'
              ? `${error} Delete any partial download and start again.`
              : ''}
      </p>
    </Section>
  );
}
