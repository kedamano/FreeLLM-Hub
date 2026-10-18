import { formatNumber } from '../lib/format';

interface PaginationBarProps {
  /** Zero-based current page. */
  page: number;
  /** Total number of pages (always >= 1). */
  pageCount: number;
  /** Total number of records across all pages. */
  total: number;
  /** Noun for the record unit, e.g. "条" or "个模型". */
  unitLabel?: string;
  onPageChange: (page: number) => void;
  /** When provided, a page-size selector is rendered. */
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
}

/**
 * Shared pagination footer extracted from the request-audit screen so every data
 * list (calls, models, audit) reads and behaves the same. Purely presentational —
 * the caller owns whether paging is client-side or driven by limit/offset.
 */
export default function PaginationBar({
  page,
  pageCount,
  total,
  unitLabel = '条',
  onPageChange,
  pageSize,
  pageSizeOptions = [20, 50, 100],
  onPageSizeChange,
}: PaginationBarProps) {
  const safePageCount = Math.max(1, pageCount);
  const hasMultiplePages = safePageCount > 1;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] text-surface-500">
      <div className="flex items-center gap-3">
        <span>
          共 <span className="font-medium text-surface-700">{formatNumber(total)}</span> {unitLabel}
        </span>
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span className="text-surface-400">每页</span>
            <select
              aria-label="每页显示数量"
              className="input-field h-7 py-0 pl-2 pr-6 text-[11px] w-auto"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {hasMultiplePages && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            disabled={page <= 0}
            onClick={() => onPageChange(Math.max(0, page - 1))}
          >
            上一页
          </button>
          <span className="tabular-nums">
            第 {page + 1} / {safePageCount} 页
          </span>
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            disabled={page + 1 >= safePageCount}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
