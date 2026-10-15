// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useIPC, useIPCMutation } from '../../src/renderer/src/hooks/useIPC';

function AsyncDataComponent({ fetcher }: { fetcher: () => Promise<string> }): JSX.Element {
  const { data, loading, error, refetch } = useIPC(fetcher);

  if (loading) return <div data-testid="loading">Loading</div>;
  if (error) return <div data-testid="error">{error}</div>;
  if (data) return <div data-testid="data">{data}</div>;

  return <div data-testid="initial">Initial</div>;
}

function MutationComponent(): JSX.Element {
  const { mutate, loading } = useIPCMutation<string, string>();

  const handleClick = async () => {
    await mutate(async (input) => `Result: ${input}`, 'test');
  };

  return (
    <div>
      <button onClick={handleClick} disabled={loading}>
        {loading ? 'Processing...' : 'Submit'}
      </button>
    </div>
  );
}

describe('useIPC', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('should start in loading state', () => {
    const fetcher = vi.fn().mockResolvedValue('data');
    render(<AsyncDataComponent fetcher={fetcher} />);
    expect(screen.getByTestId('loading')).toBeInTheDocument();
  });

  it('should display data after successful fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue('Hello World');
    render(<AsyncDataComponent fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId('data')).toBeInTheDocument();
    });
    expect(screen.getByTestId('data')).toHaveTextContent('Hello World');
  });

  it('should display error on fetch failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network error'));
    render(<AsyncDataComponent fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId('error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('error')).toHaveTextContent('Network error');
  });

  it('should call refetch when triggered', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('First')
      .mockResolvedValueOnce('Second');

    function RefetchComponent(): JSX.Element {
      const { data, refetch } = useIPC(fetcher);
      return (
        <div>
          <div data-testid="data">{data || 'none'}</div>
          <button onClick={() => refetch()}>Refetch</button>
        </div>
      );
    }

    render(<RefetchComponent />);

    await waitFor(() => {
      expect(screen.getByTestId('data')).toHaveTextContent('First');
    });

    fireEvent.click(screen.getByText('Refetch'));

    await waitFor(() => {
      expect(screen.getByTestId('data')).toHaveTextContent('Second');
    });
  });

  it('should handle non-Error exceptions', async () => {
    const fetcher = vi.fn().mockRejectedValue('string error');
    render(<AsyncDataComponent fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId('error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('error')).toHaveTextContent('请求失败');
  });
});

describe('useIPCMutation', () => {
  it('should start in idle state', () => {
    render(<MutationComponent />);
    expect(screen.getByText('Submit')).toBeInTheDocument();
  });

  it('should show loading state during mutation', async () => {
    render(<MutationComponent />);

    fireEvent.click(screen.getByText('Submit'));

    expect(screen.getByText('Processing...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Submit')).toBeInTheDocument();
    });
  });

  it('should show error on mutation failure', async () => {
    function FailingMutation(): JSX.Element {
      const { mutate, error } = useIPCMutation<string, string>();

      const handleClick = async () => {
        await mutate(async () => {
          throw new Error('Mutation failed');
        }, 'input');
      };

      return (
        <div>
          <button onClick={handleClick}>Trigger</button>
          {error && <span data-testid="error">{error}</span>}
        </div>
      );
    }

    render(<FailingMutation />);
    fireEvent.click(screen.getByText('Trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('error')).toHaveTextContent('Mutation failed');
    });
  });
});
