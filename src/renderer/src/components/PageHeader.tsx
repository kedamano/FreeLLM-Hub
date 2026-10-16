interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

/**
 * Page title block.
 *
 * Kept outside of loading/error branches on purpose: a page that swaps its own title
 * for a spinner makes the app feel like navigation failed, and it makes end-to-end
 * assertions on "which page am I on" impossible to write stably.
 */
export default function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-bold text-surface-900 tracking-tight">{title}</h2>
        {description && <p className="text-sm text-surface-500 mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
    </div>
  );
}
