// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Sidebar from '../../src/renderer/src/components/Sidebar';

describe('Sidebar', () => {
  const mockNavigate = vi.fn();

  beforeEach(() => {
    mockNavigate.mockClear();
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
    expect(screen.getByText('用量统计')).toBeInTheDocument();
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

    fireEvent.click(screen.getByText('用量统计'));
    expect(mockNavigate).toHaveBeenCalledWith('usage');

    fireEvent.click(screen.getByText('设置'));
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('should render the version info', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={mockNavigate} />);
    expect(screen.getByText('版本 0.1.0')).toBeInTheDocument();
  });
});
