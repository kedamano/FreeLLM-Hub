import type { Page } from './nav';
import { NAV_ITEMS } from './nav';

/**
 * The page a user is looking at belongs in the URL: refreshes should come back to the
 * same screen, a support reply should be able to point at `#/audit?request=…`, and the
 * browser back button should undo a navigation. It used to live only in React state, so
 * every one of those lost the screen.
 *
 * Hash routing rather than path routing because the same bundle also runs from
 * `file://` inside the packaged desktop app, where pushed paths resolve against the
 * filesystem instead of the SPA.
 */

const PAGE_IDS: Page[] = NAV_ITEMS.map((item) => item.id);

export function isPage(value: unknown): value is Page {
  return typeof value === 'string' && (PAGE_IDS as string[]).includes(value);
}

/** `'/'` is the dashboard; the other screens take their own name as the path. */
export function pathForPage(page: Page): string {
  return page === 'dashboard' ? '/' : `/${page}`;
}

/** Anything unrecognised lands on the dashboard, and the caller rewrites the URL. */
export function pageFromPath(pathname: string): Page {
  const segment = pathname.replace(/^\/+|\/+$/g, '');
  return isPage(segment) ? segment : 'dashboard';
}

export { PAGE_IDS };
