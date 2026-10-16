import type { ComponentType } from 'react';
import {
  AuditIcon,
  DashboardIcon,
  ModelIcon,
  ProfileIcon,
  ProviderIcon,
  SettingsIcon,
  UsageIcon,
} from '../components/Icons';

export type Page =
  | 'dashboard'
  | 'providers'
  | 'models'
  | 'usage'
  | 'audit'
  | 'profiles'
  | 'settings';

export interface NavItem {
  id: Page;
  label: string;
  icon: ComponentType<{ className?: string; size?: number }>;
  hint?: string;
}

/**
 * Navigation order mirrors the operator's loop: see the pool (服务商/模型目录),
 * watch what it cost (用量与成本 / 请求审计), then adjust per project (配置档).
 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: '仪表盘', icon: DashboardIcon },
  { id: 'providers', label: '服务商', icon: ProviderIcon },
  { id: 'models', label: '模型目录', icon: ModelIcon },
  { id: 'usage', label: '用量与成本', icon: UsageIcon },
  { id: 'audit', label: '请求审计', icon: AuditIcon },
  { id: 'profiles', label: '配置档', icon: ProfileIcon },
  { id: 'settings', label: '设置', icon: SettingsIcon },
];
