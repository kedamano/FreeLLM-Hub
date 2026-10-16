import { memo, useEffect, useState } from 'react';
import {
  DashboardIcon,
  ProviderIcon,
  ModelIcon,
  UsageIcon,
  SettingsIcon,
} from './Icons';
import { getFreellmApi } from '../hooks/useIPC';

type Page = 'dashboard' | 'providers' | 'models' | 'usage' | 'settings';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

interface NavItem {
  id: Page;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: '仪表盘', icon: <DashboardIcon size={18} /> },
  { id: 'providers', label: '服务商', icon: <ProviderIcon size={18} /> },
  { id: 'models', label: '模型目录', icon: <ModelIcon size={18} /> },
  { id: 'usage', label: '用量统计', icon: <UsageIcon size={18} /> },
  { id: 'settings', label: '设置', icon: <SettingsIcon size={18} /> },
];

type GatewayState = 'running' | 'stopped' | 'unknown';

function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const [gatewayState, setGatewayState] = useState<GatewayState>('unknown');

  useEffect(() => {
    let cancelled = false;
    const api = getFreellmApi();
    if (!api) {
      setGatewayState('unknown');
      return;
    }
    api.gateway
      .status()
      .then((status) => {
        if (cancelled) return;
        const running = (status as { running?: boolean } | null)?.running === true;
        setGatewayState(running ? 'running' : 'stopped');
      })
      .catch(() => {
        if (!cancelled) setGatewayState('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const gatewayText =
    gatewayState === 'running' ? '运行中' : gatewayState === 'stopped' ? '已停止' : '状态未知';

  return (
    <aside className="w-56 bg-white border-r border-surface-100 flex flex-col">
      <div className="px-4 py-5 border-b border-surface-100">
        <h1 className="text-base font-bold text-surface-900 flex items-center gap-2.5 tracking-tight">
          <span className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center text-white text-[11px] font-bold shadow-sm">
            F
          </span>
          <span>FreeLLM Hub</span>
        </h1>
        <p className="text-[11px] text-surface-400 mt-1.5 ml-[42px] font-medium">大模型聚合管理平台</p>
      </div>

      <nav className="flex-1 p-3 space-y-0.5">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            aria-current={currentPage === item.id ? 'page' : undefined}
            className={`w-full text-left ${
              currentPage === item.id ? 'sidebar-item-active' : ''
            } sidebar-item`}
          >
            <span className={currentPage === item.id ? 'text-primary-600' : 'text-surface-400'}>
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-surface-100">
        <div className="px-3 py-2 text-[11px] text-surface-400 font-medium space-y-0.5">
          <div>本地网关：{gatewayText}</div>
          <div>版本 0.1.0</div>
        </div>
      </div>
    </aside>
  );
}

export default memo(Sidebar);
