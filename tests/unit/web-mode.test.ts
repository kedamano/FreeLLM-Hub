import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appOn, appExit, mockStartServer } = vi.hoisted(() => ({
  appOn: vi.fn(),
  appExit: vi.fn(),
  mockStartServer: vi.fn(),
}));

vi.mock('electron', () => ({ app: { on: appOn, exit: appExit } }));
vi.mock('../../src/server/index.js', () => ({ startServer: mockStartServer }));

async function load() {
  vi.resetModules();
  return import('../../src/main/web-mode.js');
}

/** The `before-quit` listener web mode registers, if any. */
function beforeQuitHandler(): ((event: { preventDefault(): void }) => void) | undefined {
  return appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1];
}

describe('isWebModeRequested', () => {
  it('reacts only to its own flag', async () => {
    const { isWebModeRequested } = await load();

    expect(isWebModeRequested(['C:\\app\\FreeLLM Hub.exe', '--web'])).toBe(true);
    expect(isWebModeRequested(['/usr/bin/FreeLLM', '--web', '--no-sandbox'])).toBe(true);
    expect(isWebModeRequested(['FreeLLM', '--webby'])).toBe(false);
    expect(isWebModeRequested(['FreeLLM'])).toBe(false);
  });
});

describe('runWebMode', () => {
  let shutdown: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    shutdown = vi.fn().mockResolvedValue(undefined);
    mockStartServer.mockResolvedValue({ shutdown });
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    vi.clearAllMocks();
  });

  it('starts the server and exits only after it drained', async () => {
    const { runWebMode } = await load();
    const server = await runWebMode();

    expect(mockStartServer).toHaveBeenCalledTimes(1);
    expect(server).toEqual({ shutdown });

    process.emit('SIGINT');
    await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('treats a second signal as the same shutdown, not two', async () => {
    const { runWebMode } = await load();
    await runWebMode();

    process.emit('SIGINT');
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(appExit).toHaveBeenCalledTimes(1));

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('routes a programmatic quit through the shutdown instead of cutting it short', async () => {
    const { runWebMode } = await load();
    await runWebMode();

    const handler = beforeQuitHandler();
    expect(handler).toBeDefined();

    const preventDefault = vi.fn();
    handler!({ preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
