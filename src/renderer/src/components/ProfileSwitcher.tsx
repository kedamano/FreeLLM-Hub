import { useProfiles } from '../hooks/useProfiles';
import { formatNumber, formatUsd } from '../lib/format';

/**
 * Active-profile selector. Lives in the sidebar so the pool in effect is always
 * visible — every number on the usage and audit panels is scoped to it.
 */
export default function ProfileSwitcher({ onManage }: { onManage?: () => void }) {
  const { profiles, active, activeProfileId, loading, switchTo } = useProfiles();

  if (loading && profiles.length === 0) return null;

  return (
    <div className="px-3 pb-2">
      <label className="label mb-1 block">当前配置档</label>
      <select
        className="input-field w-full text-xs"
        value={activeProfileId ?? ''}
        onChange={(event) => {
          if (event.target.value && event.target.value !== activeProfileId) {
            void switchTo(event.target.value);
          }
        }}
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
            {profile.isDefault ? '（默认）' : ''}
          </option>
        ))}
      </select>
      {active && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-surface-400">
          <span>
            {formatNumber(active.stats.requests)} 次 · {formatNumber(active.stats.tokens)} tokens
          </span>
          <span className="text-teal-600">省 {formatUsd(active.stats.savedCostUsd)}</span>
        </div>
      )}
      {onManage && (
        <button type="button" className="btn-ghost mt-1.5 w-full text-[11px]" onClick={onManage}>
          管理配置档
        </button>
      )}
    </div>
  );
}
