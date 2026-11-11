/**
 * Saving the charter while it is typed: the queue behind "Saved just now".
 *
 * The server has one save, a full replace based on a revision (`PUT /charter`; a save based on an
 * older revision is a 409 `stale`). So this is a queue of one: a single write in flight, the latest
 * text held behind it, and each response's revision becoming the next write's base. Two quick edits
 * are two writes in order, never two writes racing each other into a `stale` of our own making.
 *
 * Nothing here ever drops text. `latest` is what was typed, and it stays until a write that carried
 * it was acknowledged. A conflict or a failure only stops the queue; the words are still here for
 * the person to keep, copy or save again.
 *
 * Framework-free so the order of writes can be tested with a slow fake.
 */
import type { WriteCharterResult } from '@onmyradar/contract';
import { ApiError } from './api';

export type SaveState =
  /** The server holds what is typed. */
  | 'saved'
  /** Typed since the last write; one is scheduled. */
  | 'dirty'
  | 'saving'
  /** The network failed (or the server was not ready): retrying on its own. */
  | 'paused'
  /** Somebody else saved first. Stopped until the person reloads or keeps theirs. */
  | 'conflict'
  /** The server refused this text (too long, no access). Stopped; `message` says why. */
  | 'refused';

export interface SaveSnapshot {
  state: SaveState;
  /** When the last write was acknowledged. */
  savedAt: number | null;
  message: string | null;
  /** The head revision when `state` is `conflict`. */
  headRevision: number | null;
}

export interface SavedWrite {
  result: WriteCharterResult;
  /** The text this write carried, and the text the server held before it. */
  sent: string;
  before: string;
}

export interface SaverDeps {
  write: (input: {
    markdown: string;
    baseRevision: number;
    checkpoint: boolean;
  }) => Promise<WriteCharterResult>;
  /** Idle time after the last keystroke before a write. */
  delay?: number;
  /** Quiet time after an autosave before the text is sealed as a version of its own. */
  checkpointAfter?: number;
  onChange?: (snapshot: SaveSnapshot) => void;
  onSaved?: (write: SavedWrite) => void;
  /**
   * The charter as the server holds it. Asked when a retry is told it is stale: the write that
   * was thought lost may have landed, and then the "conflict" is only our own text.
   */
  head?: () => Promise<{ markdown: string; revision: number }>;
  now?: () => number;
}

/** Autosave waits for the typing to stop, then writes without sealing: a version is made by Done. */
export const AUTOSAVE_IDLE_MS = 2000;
/** And the typing, left alone this long with the editor open, is sealed anyway. */
export const CHECKPOINT_IDLE_MS = 10 * 60 * 1000;
const RETRY_MS = [2000, 5000, 15000, 30000];

export class CharterSaver {
  private saved: string;
  private revision: number;
  private text: string;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  /**
   * A write was sent and its answer never came back: the server may hold it or not. Until some
   * answer settles that, `dirty` is true whatever the editor holds, because "the same as what was
   * last acknowledged" no longer says what the server has.
   */
  private unknown = false;
  /** The server's head was written without a seal and has not been sealed since. */
  private unsealed = false;
  private sealTimer: ReturnType<typeof setTimeout> | null = null;
  private snap: SaveSnapshot = { state: 'saved', savedAt: null, message: null, headRevision: null };

  constructor(
    start: { markdown: string; revision: number },
    private readonly deps: SaverDeps,
  ) {
    this.saved = start.markdown;
    this.text = start.markdown;
    this.revision = start.revision;
  }

  get snapshot(): SaveSnapshot {
    return this.snap;
  }
  /** What was typed last; the text a conflict or a failure keeps safe. */
  get latest(): string {
    return this.text;
  }
  /** What the server holds, as far as this queue knows. */
  get server(): string {
    return this.saved;
  }
  get baseRevision(): number {
    return this.revision;
  }
  get dirty(): boolean {
    return this.text !== this.saved || this.unknown;
  }

  private set(patch: Partial<SaveSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.deps.onChange?.(this.snap);
  }

  /** The text as it is now. Called on every change the editor reports. */
  push(markdown: string): void {
    // The editor reports on every selection move too: the same text again is not typing.
    const same = markdown === this.text;
    this.text = markdown;
    if (same && (this.timer !== null || this.inflight !== null)) return;
    if (this.stopped) return;
    // Words changed after the server refused the text (too long): that is a new try.
    if (this.snap.state === 'refused' && !same) this.set({ state: 'dirty', message: null });
    if (this.halted()) return;
    if (!this.dirty && this.inflight === null) {
      this.clear();
      this.set({ state: 'saved', message: null });
      return;
    }
    if (this.inflight === null) {
      this.set({ state: 'dirty', message: null });
      this.arm(this.deps.delay ?? AUTOSAVE_IDLE_MS);
    }
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearSeal(): void {
    if (this.sealTimer) clearTimeout(this.sealTimer);
    this.sealTimer = null;
  }

  private arm(ms: number): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  /** Write now what is typed, and settle: resolves when nothing is left to write (or it cannot be). */
  async flush(): Promise<void> {
    this.clear();
    if (this.halted()) return;
    for (let guard = 0; guard < 50 && (this.dirty || this.inflight !== null); guard += 1) {
      await this.run();
      if (this.halted() || this.snap.state === 'paused') return;
    }
  }

  /**
   * Done: write what is typed, then seal it as a version. Resolves with the text that is on the
   * server and sealed, or null when it cannot be (a conflict, a refusal, no network): nothing was
   * closed, nothing is lost. Whatever was typed while it ran is still `latest`, so a caller
   * compares and goes again rather than closing over it.
   */
  async finish(): Promise<string | null> {
    await this.flush();
    if (this.halted() || this.snap.state === 'paused' || this.dirty || this.inflight) return null;
    if (this.unsealed && !(await this.seal())) return null;
    return this.saved;
  }

  /** Write the server's own text again as a checkpoint: it seals the working text. */
  private async seal(): Promise<boolean> {
    this.clearSeal();
    const sent = this.saved;
    this.set({ state: 'saving', message: null });
    const attempt = (async () => {
      try {
        const result = await this.deps.write({
          markdown: sent,
          baseRevision: this.revision,
          checkpoint: true,
        });
        this.revision = result.revision;
        this.unknown = false;
        this.unsealed = false;
        this.set({
          savedAt: (this.deps.now ?? Date.now)(),
          state: this.dirty ? 'dirty' : 'saved',
          message: null,
        });
        // Typed while it was on its way: that goes next, after the idle time.
        if (this.dirty && !this.stopped) this.arm(this.deps.delay ?? AUTOSAVE_IDLE_MS);
        return true;
      } catch (error) {
        await this.fail(error, sent);
        return false;
      }
    })();
    this.inflight = attempt
      .then(() => undefined)
      .finally(() => {
        this.inflight = null;
      });
    const ok = await attempt;
    await this.inflight;
    return ok;
  }

  /** Stopped until the person decides: a conflict, or text the server will not take. */
  private halted(): boolean {
    return this.snap.state === 'conflict' || this.snap.state === 'refused';
  }

  /** Try again now, after a pause or once the person chose to keep their text over the head. */
  retry(): Promise<void> {
    if (this.snap.state === 'paused') this.set({ state: 'dirty', message: null });
    return this.flush();
  }

  /** The person took the head: whatever was typed is let go (they have copied it, or chose to). */
  adopt(start: { markdown: string; revision: number }): void {
    this.clear();
    this.clearSeal();
    this.unsealed = false;
    this.unknown = false;
    this.saved = start.markdown;
    this.text = start.markdown;
    this.revision = start.revision;
    this.attempts = 0;
    this.set({ state: 'saved', message: null, headRevision: null });
  }

  /** The editor is closing: no more writes, no more state changes. */
  stop(): void {
    this.stopped = true;
    this.clear();
    this.clearSeal();
  }

  private run(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.dirty) {
      this.set({ state: 'saved', message: null });
      return Promise.resolve();
    }
    const sent = this.text;
    const before = this.saved;
    this.clear();
    this.set({ state: 'saving', message: null });
    const attempt = (async () => {
      try {
        const result = await this.deps.write({
          markdown: sent,
          baseRevision: this.revision,
          checkpoint: false,
        });
        this.revision = result.revision;
        this.saved = sent;
        this.unknown = false;
        this.attempts = 0;
        if (result.changed) this.unsealed = true;
        this.armSeal();
        this.set({
          savedAt: (this.deps.now ?? Date.now)(),
          state: this.dirty ? 'dirty' : 'saved',
          message: null,
        });
        this.deps.onSaved?.({ result, sent, before });
        // Typed while that write was in flight: the next one follows after the idle time.
        if (this.dirty && !this.stopped) this.arm(this.deps.delay ?? AUTOSAVE_IDLE_MS);
      } catch (error) {
        await this.fail(error, sent);
      }
    })().finally(() => {
      this.inflight = null;
    });
    this.inflight = attempt;
    return attempt;
  }

  /** Left alone for a while with the editor open, the working text is sealed as it is. */
  private armSeal(): void {
    this.clearSeal();
    if (!this.unsealed || this.stopped) return;
    this.sealTimer = setTimeout(() => {
      this.sealTimer = null;
      if (this.dirty || this.inflight || this.halted() || this.stopped) this.armSeal();
      else void this.seal();
    }, this.deps.checkpointAfter ?? CHECKPOINT_IDLE_MS);
  }

  /** A retry after a lost answer is stale only because the first try landed: the head is ours. */
  private async landed(sent: string): Promise<boolean> {
    try {
      const head = await this.deps.head?.();
      if (!head || head.markdown !== sent) return false;
      this.revision = head.revision;
      this.saved = sent;
      this.attempts = 0;
      this.unknown = false;
      this.unsealed = true;
      this.armSeal();
      this.set({
        savedAt: (this.deps.now ?? Date.now)(),
        state: this.dirty ? 'dirty' : 'saved',
        message: null,
      });
      if (this.dirty && !this.stopped) this.arm(this.deps.delay ?? AUTOSAVE_IDLE_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async fail(error: unknown, sent: string): Promise<void> {
    if (error instanceof ApiError && error.status === 409 && error.code === 'stale') {
      if (this.attempts > 0 && (await this.landed(sent))) return;
      const head = Number(error.fields?.['revision']);
      this.set({
        state: 'conflict',
        message: error.message,
        headRevision: Number.isFinite(head) ? head : null,
      });
      return;
    }
    // The server was not ready (a migration in flight), or it did not answer: say so and go again.
    const transient =
      !(error instanceof ApiError) ||
      error.status >= 500 ||
      error.status === 429 ||
      error.code === 'charter_not_ready';
    if (!transient) {
      this.set({
        state: 'refused',
        message: error instanceof ApiError ? error.message : 'The charter was not saved.',
      });
      return;
    }
    // No answer is not a refusal: the write may have been made, so what the server holds is unknown.
    if (!(error instanceof ApiError) || error.status >= 500) this.unknown = true;
    // A 429 is not an error and not a lost draft: the text stays, and the next try is no sooner
    // than the server said (`Retry-After`), whatever the back-off would have been.
    const asked = error instanceof ApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0;
    const wait = Math.max(
      RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)] ?? 30000,
      error instanceof ApiError && error.status === 429 ? asked : 0,
    );
    this.attempts += 1;
    this.set({ state: 'paused', message: 'Saving paused. Your text is kept here.' });
    if (!this.stopped) this.arm(wait);
  }
}
