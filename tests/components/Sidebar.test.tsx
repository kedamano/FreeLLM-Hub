// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from '../../src/renderer/src/components/Sidebar';

describe('Sidebar', () => {
  const mockNavigate = vi.fn();

  beforeEach(() => {
    mockNavigate.mockClear();
    // The sidebar renders a live profile switcher and gateway status; without a stub
    // every test leaves a pending promise that resolves after the assertion and React
    // warns about an update outside act().
    Object.defineProperty(window, 'freellm', {
      configurable: true,
      value: {
        profiles: {
          list: async () => [
            {
              id: 'default',
              name: '默认配置档',
              description: null,
              isDefault: true,
              isActive: true,
              metadata: null,
              createdAt: '2026-10-16T00:00:00.000Z',
              updatedAt: '2026-10-16T00:00:00.000Z',
              stats: {
                profileId: 'default',
                enabledProviders: 2,
                quotaConfigured: 0,
                requests: 0,
                tokens: 0,
                costUsd: 0,
                savedCostUsd: 0,
              },
            },
          ],
          active: async () => null,
        },
        gateway: { status: async () => ({ running: true }) },
      },
    });
  });

  it('should render the app title', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={mockNavigate} />);
    expect(screen.getByText('FreeLLM Hub')).toBeInTheDocument();
  });

  it('should render all navigation items', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={mockNavigate} />);
    expect(screen.getByText('仪表盘')).toBeInTheDocument();
    expect(screen.getByText('服务商')).toBeInTheDocument();
    expect(screen.getByText('模型目录')).toBeInTheDocument();
    expect(screen.getByText('用量与成本')).toBeInTheDocument();
    expect(screen.getByText('请求审计')).toBeInTheDocument();
    expect(screen.getByText('配置档')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
  });

  it('should call onNavigate when clicking a nav item', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={mockNavigate} />);
    fireEvent.click(screen.getByText('服务商'));
    expect(mockNavigate).toHaveBeenCalledWith('providers');
  });

  it('should call onNavigate for each page', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={mockNavigate} />);

    fireEvent.click(screen.getByText('模型目录'));
    expect(mockNavigate).toHaveBeenCalledWith('models');

    fireEvent.click(screen.getByText('用量与成本'));
    expect(mockNavigate).toHaveBeenCalledWith('usage');

    fireEvent.click(screen.getByText('请求审计'));
    expect(mockNavigate).toHaveBeenCalledWith('audit');

    fireEvent.click(screen.getByText('配置档'));
    expect(mockNavigate).toHaveBeenCalledWith('profiles');

    fireEvent.click(screen.getByText('设置'));
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('should render the version info', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={mockNavigate} />);
    expect(screen.getByText('版本 0.1.0')).toBeInTheDocument();
  });
});
