// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ErrorBoundary,
  LoadingState,
  ErrorState,
  EmptyState,
} from '../../src/renderer/src/components/ErrorBoundary';

function ThrowingComponent(): JSX.Element {
  throw new Error('Test error component');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should render children when no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Child Content</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Child Content');
  });

  it('should render fallback when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('出现了一些问题')).toBeInTheDocument();
  });

  it('should display error message from thrown error', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Test error component')).toBeInTheDocument();
  });

  it('should render custom fallback if provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">Custom Fallback</div>}>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('custom')).toHaveTextContent('Custom Fallback');
  });

  it('should recover when clicking reload button', () => {
    let shouldThrow = true;

    function ConditionalThrow(): JSX.Element {
      if (shouldThrow) {
        throw new Error('Conditional error');
      }
      return <div data-testid="recovery">Recovered</div>;
    }

    render(
      <ErrorBoundary>
        <ConditionalThrow />
      </ErrorBoundary>
    );

    expect(screen.getByText('出现了一些问题')).toBeInTheDocument();
    expect(screen.getByText('重新加载')).toBeInTheDocument();

    // 关闭 throw 后点击重置
    shouldThrow = false;
    fireEvent.click(screen.getByText('重新加载'));

    expect(screen.getByTestId('recovery')).toHaveTextContent('Recovered');
  });
});

describe('LoadingState', () => {
  it('should render default loading message', () => {
    render(<LoadingState />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('should render custom loading message', () => {
    render(<LoadingState message="Fetching models..." />);
    expect(screen.getByText('Fetching models...')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('should render error message', () => {
    render(<ErrorState message="Connection failed" />);
    expect(screen.getByText('出错了')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('should render retry button', () => {
    const mockRetry = vi.fn();
    render(<ErrorState message="Failed" onRetry={mockRetry} />);
    const retryButton = screen.getByText('重试');
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);
    expect(mockRetry).toHaveBeenCalledOnce();
  });

  it('should not render retry button if no onRetry', () => {
    render(<ErrorState message="Failed" />);
    expect(screen.queryByText('重试')).not.toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('should render default empty message', () => {
    render(<EmptyState />);
    expect(screen.getByText('暂无数据')).toBeInTheDocument();
  });

  it('should render custom empty message', () => {
    render(<EmptyState message="No providers configured" />);
    expect(screen.getByText('No providers configured')).toBeInTheDocument();
  });
});
