import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/** Modal built on the native <dialog> element: focus trapping and Escape come for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Overrides the width, e.g. for a file preview. */
  className?: string;
  /** Buttons shown in the header, left of Close. */
  actions?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={cn(
        'm-auto w-[min(640px,calc(100vw-32px))] rounded-lg border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="min-w-0 truncate font-semibold">{title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="p-5">{open && children}</div>
    </dialog>
  );
}
