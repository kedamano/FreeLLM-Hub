import pino from 'pino';
import { resolve as resolvePath } from 'node:path';
import { getAppConfig } from '../config/app-config.js';

type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

// `silent` is a valid pino level, so it is a legal LOG_LEVEL value.
const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

/**
 * The transport pair the whole process logs through. Two facts here are load-bearing:
 *
 * - `pino-roll` owns the file. It used to be `pino-pretty` writing straight to the log with a
 *   `destination`, and that holds one file descriptor open forever, so the file grew without
 *   bound. `size` rolls it, `limit.count` deletes the oldest roll: that is the disk bound that
 *   SQLite-side `log-retention` never covered.
 * - The pretty target has no `destination`, so it goes to stdout while the roll target writes
 *   the file. Reversing that is what silently disabled rotation before — a chained pretty target
 *   formats for its own destination, not for the next one, so the rolled file stays NDJSON.
 */
export function buildAppLoggerOptions(): pino.LoggerOptions {
  const { level, file, maxSizeMb, maxFiles } = readLogLimits();
  return {
    level,
    transport: {
      targets: [
        { target: 'pino-pretty', options: { colorize: false } },
        {
          target: 'pino-roll',
          // A number is MB to pino-roll. Its string parser only accepts a single unit letter, so
          // the natural-looking `10mb` throws inside the transport worker.
          options: { file, size: maxSizeMb, limit: { count: maxFiles }, mkdir: true },
        },
      ],
    },
  };
}

/** `getAppConfig()` creates directories, so a read-only disk must not take the process down. */
function readLogLimits() {
  try {
    const config = getAppConfig();
    return {
      level: LOG_LEVELS.find((level) => level === config.logLevel) ?? 'info',
      file: resolvePath(config.logDir, 'app.log'),
      maxSizeMb: config.logMaxSizeMb,
      maxFiles: config.logMaxFiles,
    };
  } catch {
    return {
      level: 'info' as const,
      file: resolvePath('logs', 'app.log'),
      maxSizeMb: 10,
      maxFiles: 5,
    };
  }
}

let rootLogger: pino.Logger | null = null;

/**
 * The one pino instance per process: handed to Fastify as `loggerInstance` and used for every
 * line that used to be `console.*`, which was dropped in the packaged app where there is no
 * terminal.
 */
export function getAppLogger(): pino.Logger {
  if (!rootLogger) {
    const options = buildAppLoggerOptions();
    // Skip the transport entirely at `silent` so nothing spawns a worker or creates a file — this
    // is what the test suite runs with.
    rootLogger = options.level === 'silent' ? pino({ level: 'silent' }) : pino(options);
  }
  return rootLogger;
}

const children = new Map<string, pino.Logger>();

/**
 * A logger tagged with its subsystem, so `[Usage]`-style prefixes become a filterable field.
 * Cached, which also lets a test spy on the exact object a module logs through.
 */
export function loggerFor(component: string): pino.Logger {
  const existing = children.get(component);
  if (existing) return existing;
  const child = getAppLogger().child({ component });
  children.set(component, child);
  return child;
}
