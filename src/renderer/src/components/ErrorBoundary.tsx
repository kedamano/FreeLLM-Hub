import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="text-4xl mb-4 opacity-50" aria-hidden="true">
            ⚠
          </div>
          <h3 className="text-lg font-semibold text-surface-800 mb-2">
            出现了一些问题
          </h3>
          <p className="text-sm text-surface-500 max-w-md mb-4">
            {this.state.error?.message || '应用遇到了意外错误，请刷新重试。'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="btn-primary"
          >
            重新加载
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export function LoadingState({ message = '加载中...' }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-3 text-surface-400">
        <span className="inline-block w-4 h-4 border-2 border-primary-300 border-t-primary-600 rounded-full animate-spin" />
        <span className="text-sm">{message}</span>
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="text-red-400 mb-2 text-lg">出错了</div>
      <p className="text-sm text-surface-500 mb-4">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary text-xs">
          重试
        </button>
      )}
    </div>
  );
}

export function EmptyState({ message = '暂无数据' }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-center">
      <div className="text-surface-400 text-2xl mb-2" aria-hidden="true">∅</div>
      <p className="text-sm text-surface-400">{message}</p>
    </div>
  );
}
