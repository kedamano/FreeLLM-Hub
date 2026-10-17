import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../../src/renderer/src/lib/nav';
import { isPage, pageFromPath, PAGE_IDS, pathForPage } from '../../src/renderer/src/lib/routes';

describe('pageFromPath / pathForPage', () => {
  it('round-trips every navigable page', () => {
    for (const item of NAV_ITEMS) {
      expect(pageFromPath(pathForPage(item.id))).toBe(item.id);
    }
  });

  it('uses the root path for the dashboard only', () => {
    expect(pathForPage('dashboard')).toBe('/');
    expect(pathForPage('providers')).toBe('/providers');
  });

  it('accepts leading and trailing slashes', () => {
    expect(pageFromPath('/audit')).toBe('audit');
    expect(pageFromPath('audit/')).toBe('audit');
    expect(pageFromPath('/usage/')).toBe('usage');
  });

  it('falls back to the dashboard for anything unknown', () => {
    expect(pageFromPath('/')).toBe('dashboard');
    expect(pageFromPath('')).toBe('dashboard');
    expect(pageFromPath('/nope')).toBe('dashboard');
    expect(pageFromPath('/providers/settings')).toBe('dashboard');
  });

  it('exposes exactly the pages the sidebar renders', () => {
    expect(PAGE_IDS).toEqual(NAV_ITEMS.map((item) => item.id));
  });
});

describe('isPage', () => {
  it('accepts page ids and rejects everything else', () => {
    expect(isPage('settings')).toBe(true);
    expect(isPage('settings?request=1')).toBe(false);
    expect(isPage('')).toBe(false);
    expect(isPage(undefined)).toBe(false);
    expect(isPage(1)).toBe(false);
  });

  it('does not treat object keys as pages', () => {
    expect(isPage('constructor')).toBe(false);
    expect(isPage('__proto__')).toBe(false);
  });
});
