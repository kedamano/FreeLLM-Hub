// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  numberFromParam,
  useNumberQueryParam,
  useQueryParam,
  useQueryParams,
} from '../../src/renderer/src/hooks/useQueryParam';

const KEYS = ['provider', 'group'] as const;

function harness(initialEntry: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
  };
}

function renderParams(initialEntry: string) {
  return renderHook(
    () => {
      const [values, patch] = useQueryParams(KEYS);
      return { values, patch, search: useLocation().search };
    },
    { wrapper: harness(initialEntry) }
  );
}

describe('useQueryParams', () => {
  it('reads the initial selection out of the link', () => {
    const { result } = renderParams('/providers?provider=groq&group=cloud');
    expect(result.current.values.provider).toBe('groq');
    expect(result.current.values.group).toBe('cloud');
  });

  it('leaves a key that is not in the link undefined', () => {
    const { result } = renderParams('/providers');
    expect(result.current.values.provider).toBeUndefined();
  });

  it('keeps the other keys when one changes', () => {
    const { result } = renderParams('/providers?provider=groq&group=cloud');
    act(() => result.current.patch({ group: 'custom' }));
    expect(result.current.values.group).toBe('custom');
    expect(result.current.values.provider).toBe('groq');
  });

  it('drops a key for null, undefined and the empty string', () => {
    const { result } = renderParams('/providers?provider=groq&group=cloud');
    act(() => result.current.patch({ provider: null }));
    expect(result.current.values.provider).toBeUndefined();
    act(() => result.current.patch({ group: '' }));
    expect(result.current.values.group).toBeUndefined();
    expect(result.current.search).toBe('');
  });

  it('writes numbers and booleans as strings', () => {
    const { result } = renderParams('/providers?provider=groq');
    act(() => result.current.patch({ group: true }));
    expect(result.current.values.group).toBe('true');
  });

  it('composes two writes fired before React re-renders', () => {
    const { result } = renderParams('/providers');
    act(() => {
      result.current.patch({ provider: 'groq' });
      result.current.patch({ group: 'cloud' });
    });
    expect(result.current.search).toBe('?provider=groq&group=cloud');
  });

  it('replaces rather than pushing, so one back step leaves the screen', () => {
    const { result } = renderHook(
      () => {
        const [, patch] = useQueryParams(KEYS);
        return { patch, navigate: useNavigate(), location: useLocation() };
      },
      {
        wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
          return (
            <MemoryRouter initialEntries={['/first', '/providers?provider=groq']} initialIndex={1}>
              {children}
            </MemoryRouter>
          );
        },
      }
    );
    act(() => {
      result.current.patch({ provider: 'ollama' });
      result.current.patch({ group: 'local' });
    });
    expect(result.current.location.pathname).toBe('/providers');
    act(() => result.current.navigate(-1));
    // Two pushes would have landed back on '/providers'; a replace left one entry behind.
    expect(result.current.location.pathname).toBe('/first');
  });
});

describe('useQueryParam', () => {
  it('reads and writes a single key', () => {
    const { result } = renderHook(() => useQueryParam('q'), {
      wrapper: harness('/models?q=llama'),
    });
    expect(result.current[0]).toBe('llama');
    act(() => result.current[1]('gemma'));
    expect(result.current[0]).toBe('gemma');
    act(() => result.current[1](undefined));
    expect(result.current[0]).toBeUndefined();
  });
});

describe('useNumberQueryParam', () => {
  function render(initialEntry: string) {
    return renderHook(
      () => ({
        days: useNumberQueryParam('days', 7, 1),
        search: useLocation().search,
      }),
      { wrapper: harness(initialEntry) }
    );
  }

  it('uses the fallback when the key is absent', () => {
    expect(render('/usage').result.current.days[0]).toBe(7);
  });

  it('falls back for garbage and out-of-range links', () => {
    expect(render('/usage?days=abc').result.current.days[0]).toBe(7);
    expect(render('/usage?days=0').result.current.days[0]).toBe(7);
    expect(render('/usage?days=-3').result.current.days[0]).toBe(7);
    expect(render('/usage?days=30').result.current.days[0]).toBe(30);
  });

  it('omits the fallback value instead of writing it into the link', () => {
    const { result } = render('/usage?days=30');
    act(() => result.current.days[1](7));
    expect(result.current.days[0]).toBe(7);
    expect(result.current.search).toBe('');
    act(() => result.current.days[1](90));
    expect(result.current.days[0]).toBe(90);
    expect(result.current.search).toBe('?days=90');
  });
});

describe('numberFromParam', () => {
  it('mirrors the hook rules for values read in bulk', () => {
    expect(numberFromParam(undefined, 7, 1)).toBe(7);
    expect(numberFromParam('3', 7, 1)).toBe(3);
    expect(numberFromParam('0', 7, 1)).toBe(7);
    expect(numberFromParam('0', 0, 0)).toBe(0);
    expect(numberFromParam('nope', 7, 1)).toBe(7);
    expect(numberFromParam('', 7, 1)).toBe(7);
  });
});
