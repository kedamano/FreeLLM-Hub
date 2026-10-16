import {
  Area,
  AreaChart,
  Bar,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CostSeriesPoint, ProviderDailyPoint, ProviderQuotaUsage } from '../../../shared/types/observability.js';
import { formatNumber, formatPercent, formatTokens, formatUsd } from '../lib/format';

/**
 * Chart primitives for the cost / quota panel.
 *
 * Colours are a fixed flat palette rather than generated gradients so the panel stays
 * readable in both the light UI and the packaged dark title bar screenshots.
 */
export const CHART_COLORS = [
  '#2563eb',
  '#0d9488',
  '#7c3aed',
  '#d97706',
  '#dc2626',
  '#0891b2',
  '#65a30d',
  '#db2777',
  '#4b5563',
  '#9333ea',
];

const AXIS_STYLE = { fontSize: 11, fill: '#94a3b8' };
const GRID_STYLE = { stroke: '#e2e8f0', strokeDasharray: '3 3' };

function shortDay(date: string): string {
  // `2026-10-16` -> `10/16`, keeping the axis readable at 30 days.
  const parts = date.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : date;
}

interface TooltipPayloadItem {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function ChartTooltip({
  active,
  payload,
  label,
  formatters,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  formatters: Record<string, (value: number) => string>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-surface-100 bg-white px-3 py-2 text-xs shadow-sm">
      {label !== undefined && <div className="mb-1 font-semibold text-surface-700">{label}</div>}
      {payload.map((entry) => {
        const key = String(entry.dataKey ?? '');
        const value = typeof entry.value === 'number' ? entry.value : Number(entry.value ?? 0);
        const format = formatters[key] ?? ((input: number) => String(input));
        return (
          <div key={key} className="flex items-center gap-2 text-surface-600">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: entry.color }} />
            <span>{String(entry.name ?? key)}</span>
            <span className="ml-auto font-medium text-surface-800">{format(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Daily token volume against the money the free pool saved. */
export function TokenCostTrendChart({ series }: { series: CostSeriesPoint[] }) {
  const data = series.map((point) => ({
    ...point,
    day: shortDay(point.date),
  }));

  if (data.length === 0) {
    return <ChartEmpty />;
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <XAxis dataKey="day" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
          <YAxis
            yAxisId="tokens"
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => formatTokens(value)}
          />
          <YAxis
            yAxisId="money"
            orientation="right"
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => formatUsd(value)}
            width={64}
          />
          <Tooltip
            content={
              <ChartTooltip
                formatters={{
                  tokens: (value) => `${formatNumber(value)} tokens`,
                  savedCostUsd: formatUsd,
                  costUsd: formatUsd,
                  requests: (value) => `${formatNumber(value)} 次`,
                }}
              />
            }
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            yAxisId="tokens"
            dataKey="tokens"
            name="Token 用量"
            fill={CHART_COLORS[0]}
            radius={[3, 3, 0, 0]}
            maxBarSize={22}
          />
          <Line
            yAxisId="money"
            type="monotone"
            dataKey="savedCostUsd"
            name="节省成本"
            stroke={CHART_COLORS[1]}
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="money"
            type="monotone"
            dataKey="costUsd"
            name="实际成本"
            stroke={CHART_COLORS[3]}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Tokens per provider per day, stacked, to show which free tier is carrying the load. */
export function ProviderStackChart({
  points,
  providers,
}: {
  points: ProviderDailyPoint[];
  providers: string[];
}) {
  if (points.length === 0 || providers.length === 0) return <ChartEmpty />;

  const days = [...new Set(points.map((point) => point.date))].sort();
  const data = days.map((date) => {
    const row: Record<string, number | string> = { day: shortDay(date) };
    for (const provider of providers) row[provider] = 0;
    for (const point of points) {
      if (point.date === date) row[point.providerId] = (row[point.providerId] as number) + point.tokens;
    }
    return row;
  });

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <XAxis dataKey="day" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
          <YAxis
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => formatTokens(value)}
          />
          <Tooltip
            content={<ChartTooltip formatters={{ default: (value) => `${formatNumber(value)} tokens` }} />}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {providers.map((provider, index) => (
            <Area
              key={provider}
              type="monotone"
              dataKey={provider}
              name={provider}
              stackId="tokens"
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              fillOpacity={0.55}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Daily ceiling consumption. Recharts adds nothing here — the interesting part is the
 * ratio text and the colour change as a provider approaches its limit, which is clearer
 * as an accessible DOM progress bar.
 */
export function QuotaCeilingList({ rows }: { rows: ProviderQuotaUsage[] }) {
  if (rows.length === 0) return <ChartEmpty text="还没有配置每日额度，去服务商页面为当前配置档设置上限" />;

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const requestRate = row.requestUsageRate;
        const tokenRate = row.tokenUsageRate;
        return (
          <div key={row.providerId} className="rounded-lg border border-surface-100 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold text-surface-800">{row.providerId}</span>
              <span className="text-[11px] text-surface-400">
                {row.unbounded ? '未设上限' : `周期至 ${row.periodEnd ? new Date(row.periodEnd).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}`}
              </span>
            </div>
            <div className="mt-2 space-y-1.5">
              <CeilingBar
                label="请求数"
                used={row.usedRequests}
                limit={row.limitRequests}
                rate={requestRate}
                format={(value) => formatNumber(value)}
              />
              <CeilingBar
                label="Tokens"
                used={row.usedTokens}
                limit={row.limitTokens}
                rate={tokenRate}
                format={(value) => formatTokens(value)}
              />
            </div>
            <div className="mt-2 flex items-center gap-3 text-[11px] text-surface-400">
              <span>今日实际 {formatUsd(row.todayCostUsd)}</span>
              <span className="text-teal-600">今日节省 {formatUsd(row.todaySavedUsd)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CeilingBar({
  label,
  used,
  limit,
  rate,
  format,
}: {
  label: string;
  used: number;
  limit: number | null;
  rate: number | null;
  format: (value: number) => string;
}) {
  const ratio = rate === null ? 0 : Math.min(1, rate);
  const color = rate === null ? CHART_COLORS[8] : rate >= 0.9 ? '#dc2626' : rate >= 0.7 ? '#d97706' : CHART_COLORS[0];

  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-surface-500">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-100">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${(ratio * 100).toFixed(1)}%`, background: color }}
        />
      </div>
      <span className="w-32 shrink-0 text-right text-[11px] tabular-nums text-surface-500">
        {format(used)}
        {limit !== null ? ` / ${format(limit)}` : ''}
        {rate !== null ? ` (${formatPercent(rate, 0)})` : ''}
      </span>
    </div>
  );
}

export function ChartEmpty({ text = '暂无数据' }: { text?: string }) {
  return (
    <div className="flex h-64 w-full items-center justify-center rounded-lg bg-surface-50 text-xs text-surface-400">
      {text}
    </div>
  );
}

export { GRID_STYLE };
