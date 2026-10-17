import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetAppConfigCache } from '../../src/core/config/app-config.js';

/**
 * Rotation is verified by letting a real `pino-roll` transport write: an option-shape assertion
 * alone would not have caught the failure this replaces, where the config looked correct while
 * `pino-pretty` held the log open through one fd forever and the file grew without bound.
 */
describe('app log rotation', () => {
  const previousEnv = {
    FREEELLM_DATA_DIR: process.env.FREEELLM_DATA_DIR,
    LOG_LEVEL: process.env.LOG_LEVEL,
    LOG_MAX_SIZE_MB: process.env.LOG_MAX_SIZE_MB,
    LOG_MAX_FILES: process.env.LOG_MAX_FILES,
  };
  let dir: string | null = null;

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAppConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    vi.resetModules();
  });

  /** Configure the caps, then load the module fresh so the cached logger is rebuilt. */
  async function loadLogModule() {
    dir = mkdtempSync(join(tmpdir(), 'freellm-log-'));
    process.env.FREEELLM_DATA_DIR = dir;
    process.env.LOG_LEVEL = 'info';
    // 1 MB is the floor `resolvePositiveInt` allows, so this is the smallest cap the app can ask for.
    process.env.LOG_MAX_SIZE_MB = '1';
    process.env.LOG_MAX_FILES = '2';
    resetAppConfigCache();
    vi.resetModules();
    const mod = await import('../../src/core/log/logger.js');
    return mod;
  }

  function rollTarget(options: pino.LoggerOptions) {
    const targets =
      options.transport && 'targets' in options.transport ? options.transport.targets : [];
    return targets.find((target) => target.target === 'pino-roll');
  }

  it('maps the size and file-count caps onto the pino-roll target', async () => {
    const mod = await loadLogModule();
    const options = mod.buildAppLoggerOptions();

    expect(options.level).toBe('info');
    // A number is MB to pino-roll; its string parser only accepts a single unit letter, so the
    // natural-looking `1mb` would throw inside the transport worker.
    expect(rollTarget(options)?.options).toMatchObject({
      size: 1,
      limit: { count: 2 },
      mkdir: true,
    });
    expect(rollTarget(options)?.options?.file).toBe(join(dir as string, 'logs', 'app.log'));

    // Human-readable output goes to stdout: pino-pretty must be given no `destination`, because a
    // chained pretty target formats for its own destination and the rolled file would never rotate.
    const pretty = options.transport?.targets?.find((target) => target.target === 'pino-pretty');
    expect(pretty?.options).not.toHaveProperty('destination');
  });

  it('rolls on size and keeps only LOG_MAX_FILES besides the active one', async () => {
    const mod = await loadLogModule();
    const roll = rollTarget(mod.buildAppLoggerOptions());
    expect(roll).toBeDefined();

    // Only the roll target here: writing through the real transport is the point, and the pretty
    // target would dump ~1.5 MB of formatted lines onto stdout for a test that reads files.
    const logger = pino({ level: 'info', transport: { targets: [roll as never] } });
    const logDir = join(dir as string, 'logs');

    const line = 'x'.repeat(4000);
    // Batches with an await between them: the transport checks the size after each flush, so one
    // synchronous burst overshoots the cap by its whole buffered chunk.
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 30; i++) logger.info(line);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    const files = readdirSync(logDir).filter((name) => /^app\.\d+\.log$/.test(name));
    expect(files.length).toBeGreaterThan(1);
    // `limit.count` means files *in addition to* the one being written to.
    expect(files.length).toBeLessThanOrEqual(3);

    const sizes = files.map((name) => statSync(join(logDir, name)).size);
    expect(Math.max(...sizes)).toBeLessThan(2 * 1024 * 1024);

    // The newest number can be the just-opened empty active file, so read the largest one instead.
    const fullest = files[sizes.indexOf(Math.max(...sizes))];
    const firstLine = readFileSync(join(logDir, fullest), 'utf8').split('\n', 1)[0];
    const parsed = JSON.parse(firstLine) as { level: number; msg: string };
    expect(parsed.level).toBe(30);
    expect(parsed.msg).toBe(line);
  }, 30000);

  it('tags subsystem lines with a component field and caches one child per subsystem', async () => {
    const mod = await loadLogModule();

    expect(mod.loggerFor('usage')).toBe(mod.loggerFor('usage'));
    expect(mod.loggerFor('usage')).not.toBe(mod.loggerFor('gateway'));
    // The `[Usage]` prefixes this replaces were grep-only; a bound field is filterable.
    expect(mod.loggerFor('usage').bindings()).toMatchObject({ component: 'usage' });
  });
});
