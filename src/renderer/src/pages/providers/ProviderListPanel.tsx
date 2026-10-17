import { useRef } from 'react';
import { StatusDot } from './primitives';
import type { GroupDef, ProviderGroup, ProviderInfo } from './types';

export interface ProviderGroupView extends GroupDef {
  providers: ProviderInfo[];
}

interface ProviderListPanelProps {
  groups: ProviderGroupView[];
  activeGroup: ProviderGroup;
  selectedId: string | null;
  onSelectGroup: (group: ProviderGroup, firstProviderId?: string) => void;
  onSelectProvider: (id: string) => void;
  onShowAddForm: () => void;
}

const SCROLL_STEP_PX = 240;

/**
 * The left rail: three collapsible groups of providers. Group headers stay visible and
 * only the active group expands, so the list never grows past what the panel can show.
 */
export default function ProviderListPanel({
  groups,
  activeGroup,
  selectedId,
  onSelectGroup,
  onSelectProvider,
  onShowAddForm,
}: ProviderListPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const scroll = (dir: 1 | -1) => {
    listRef.current?.scrollBy({ top: dir * SCROLL_STEP_PX, behavior: 'smooth' });
  };

  return (
    <aside className="w-full lg:w-60 xl:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-surface-100 flex flex-col min-h-0 max-h-64 lg:max-h-none bg-surface-50/30">
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.key} className="pt-3">
            <button
              onClick={() => onSelectGroup(group.key, group.providers[0]?.id)}
              className={`w-full text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                activeGroup === group.key
                  ? 'text-primary-700 bg-primary-50/80'
                  : 'text-surface-400 hover:text-surface-600'
              }`}
            >
              {group.label}
              <span className="ml-2 text-[10px] font-normal text-surface-300">
                {group.providers.length}
              </span>
            </button>
            {activeGroup === group.key && (
              <ul className="mt-1 pb-2">
                {group.providers.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => onSelectProvider(p.id)}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-all border-l-[3px] ${
                        selectedId === p.id
                          ? 'bg-primary-50/30 text-surface-900 font-medium border-l-primary-500'
                          : 'text-surface-600 hover:bg-surface-50 border-l-transparent hover:border-l-surface-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{p.displayName}</span>
                        <StatusDot
                          status={p.credentialStatus}
                          hasCredential={p.hasCredential}
                          authType={p.authType}
                        />
                      </div>
                    </button>
                  </li>
                ))}
                {group.providers.length === 0 && (
                  <li className="px-4 py-2 text-xs text-surface-400 italic">暂无服务商</li>
                )}
              </ul>
            )}
          </div>
        ))}
      </div>
      <div className="shrink-0 flex gap-2 px-3 pt-2">
        <button
          onClick={() => scroll(-1)}
          aria-label="向上翻页"
          className="flex-1 py-1.5 rounded-md border border-surface-200 bg-white text-[11px] text-surface-500 hover:text-primary-600 hover:border-primary-300 transition-colors"
        >
          ▲ 上翻
        </button>
        <button
          onClick={() => scroll(1)}
          aria-label="向下翻页"
          className="flex-1 py-1.5 rounded-md border border-surface-200 bg-white text-[11px] text-surface-500 hover:text-primary-600 hover:border-primary-300 transition-colors"
        >
          ▼ 下翻
        </button>
      </div>
      <div className="shrink-0 p-3 border-t border-surface-100">
        <button
          onClick={onShowAddForm}
          className="w-full px-3 py-2 rounded-lg text-xs font-medium text-primary-600 bg-primary-50/60 hover:bg-primary-50 border border-primary-100 transition-colors"
        >
          ＋ 添加自定义供应商
        </button>
        <p className="mt-1.5 text-[10px] text-surface-400 leading-relaxed">
          支持任意 OpenAI 兼容 API（含中转站）
        </p>
      </div>
    </aside>
  );
}
