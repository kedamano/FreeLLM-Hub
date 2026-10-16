import { app } from 'electron';
import { startServer, type WebServer } from '../server/index.js';

/** Command line switch that turns the desktop binary into the headless server. */
export const WEB_MODE_FLAG = '--web';

/**
 * `--web` reuses this same process instead of spawning a separate Node one, which is what
 * makes it work in a published build: the native modules keep the Electron ABI they were
 * packaged with, and `getAppConfig()` keeps resolving to the userData directory the
 * windowed app already wrote keys, profiles and history into. So an installed
 * `FreeLLM Hub --web` serves the very same data the desktop UI shows.
 */
export function isWebModeRequested(argv: string[] = process.argv): boolean {
  return argv.includes(WEB_MODE_FLAG);
}

/**
 * Start the admin API, gateway and bundled UI, then keep the process alive with no window.
 * Signal handling belongs here because Electron does not quit on its own when the last
 * window closes and there never was one.
 */
export async function runWebMode(): Promise<WebServer> {
  const server = await startServer();

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // `app.exit` skips the quit events again, so shutdown cannot re-enter here.
    void server.shutdown().finally(() => app.exit(0));
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  app.on('before-quit', (event) => {
    if (stopping) return;
    event.preventDefault();
    stop();
  });

  return server;
}
