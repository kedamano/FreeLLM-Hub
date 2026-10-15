import React from 'react';

type Page = 'dashboard' | 'providers' | 'models' | 'usage' | 'settings';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

interface NavItem {
  id: Page;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: '仪表盘', icon: '◉' },
  { id: 'providers', label: '服务商', icon: '⚡' },
  { id: 'models', label: '模型目录', icon: '⊞' },
  { id: 'usage', label: '用量统计', icon: '◫' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  return (
    <aside className="w-56 bg-white border-r border-surface-200 flex flex-col">
      <div className="p-4 border-b border-surface-100">
        <h1 className="text-lg font-bold text-surface-900 flex items-center gap-2">
          <span className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center text-white text-sm font-bold">
            F
          </span>
          FreeLLM Hub
        </h1>
        <p className="text-xs text-surface-400 mt-1 ml-10">大模型聚合管理平台</p>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`sidebar-item w-full text-left ${
              currentPage === item.id ? 'sidebar-item-active' : ''
            }`}
          >
            <span className="text-base">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-surface-100">
        <div className="px-3 py-2 text-xs text-surface-400">
          <div>本地网关：运行中</div>
          <div className="mt-0.5">版本 0.1.0</div>
        </div>
      </div>
    </aside>
  );
}
