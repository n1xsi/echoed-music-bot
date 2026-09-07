import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel as Level] ?? LEVELS.info;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] > threshold) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, ...args);
}

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    error: (...args) => emit('error', scope, args),
    warn: (...args) => emit('warn', scope, args),
    info: (...args) => emit('info', scope, args),
    debug: (...args) => emit('debug', scope, args),
  };
}
