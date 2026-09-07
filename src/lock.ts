import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from './logger.js';

const log = createLogger('main');

/**
 * Refuses to start when another copy of the bot is already running.
 *
 * A second instance does not fail loudly — it authenticates fine and answers
 * commands, so the visible symptoms are duplicated replies and, much more
 * confusingly, broken audio: both copies join LiveKit under the same identity,
 * and LiveKit evicts the earlier participant whenever a new one claims an
 * identity already in the room. The copies then kick each other out and the
 * loser reports `wait_pc_connection timed out`, which reads like a network
 * fault. Cheaper to prevent than to diagnose twice.
 */
export function acquireSingleInstanceLock(): () => void {
  // Keyed by install directory, so separate checkouts can run side by side.
  const key = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  const lockPath = path.join(os.tmpdir(), `echoed-music-bot-${key}.lock`);

  const holder = readHolder(lockPath);
  if (holder !== null && holder !== process.pid && isAlive(holder)) {
    throw new Error(
      `Another instance is already running (pid ${holder}). Stop it first — two ` +
      'copies fight over the same LiveKit identity and break playback for both.\n' +
      `If that process is gone, delete ${lockPath}.`,
    );
  }

  writeFileSync(lockPath, String(process.pid), 'utf8');
  log.debug(`instance lock held at ${lockPath}`);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Only ever remove our own lock: a crash-and-restart race could otherwise
    // delete the successor's file.
    if (readHolder(lockPath) === process.pid) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Nothing useful to do while shutting down.
      }
    }
  };

  process.once('exit', release);
  return release;
}

function readHolder(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // absent or unreadable — treat as free
  }
}

/** `signal 0` tests for existence without touching the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which still counts.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
