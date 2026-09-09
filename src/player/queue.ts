import type { Track } from '../audio/resolver.js';

export type LoopMode = 'off' | 'track' | 'queue';

/** Per-server track queue with loop and shuffle. */
export class Queue {
  private items: Track[] = [];
  current: Track | null = null;
  loop: LoopMode = 'off';

  get length(): number {
    return this.items.length;
  }

  get upcoming(): readonly Track[] {
    return this.items;
  }

  /** Total seconds of queued tracks, ignoring unknown/live durations. */
  get totalDuration(): number {
    return this.items.reduce((sum, t) => sum + t.duration, 0);
  }

  push(...tracks: Track[]): void {
    this.items.push(...tracks);
  }

  pushNext(track: Track): void {
    this.items.unshift(track);
  }

  /**
   * Advances to the next track, honouring loop mode.
   * `skipped` suppresses track-looping so /skip escapes a looped track.
   */
  next(skipped = false): Track | null {
    if (this.loop === 'track' && this.current && !skipped) {
      return this.current;
    }
    if (this.loop === 'queue' && this.current) {
      this.items.push(this.current);
    }
    this.current = this.items.shift() ?? null;
    return this.current;
  }

  /** Removes a 1-based position from the upcoming list. */
  remove(position: number): Track | null {
    const index = position - 1;
    if (index < 0 || index >= this.items.length) return null;
    const [removed] = this.items.splice(index, 1);
    return removed ?? null;
  }

  move(from: number, to: number): boolean {
    const fromIndex = from - 1;
    const toIndex = to - 1;
    if (fromIndex < 0 || fromIndex >= this.items.length) return false;
    if (toIndex < 0 || toIndex >= this.items.length) return false;
    const [moved] = this.items.splice(fromIndex, 1);
    if (!moved) return false;
    this.items.splice(toIndex, 0, moved);
    return true;
  }

  shuffle(): void {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = this.items[i];
      const b = this.items[j];
      if (a !== undefined && b !== undefined) {
        this.items[i] = b;
        this.items[j] = a;
      }
    }
  }

  clear(): void {
    this.items = [];
  }
}
