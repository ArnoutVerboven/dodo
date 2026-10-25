import { cn } from '@/lib/utils';

export function Meter({
  value,
  max,
  className,
}: {
  value: number;
  max: number | null;
  className?: string;
}) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-attention' : 'bg-success';
  return (
    // biome-ignore lint/a11y/useSemanticElements: styled bar; <meter> cannot be themed consistently
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      role="meter"
      aria-valuenow={value}
      aria-valuemax={max ?? undefined}
    >
      <div
        className={cn('h-full rounded-full transition-all', tone)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
