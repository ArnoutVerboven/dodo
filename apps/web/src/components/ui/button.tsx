import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const variants = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border bg-card hover:bg-accent',
  ghost: 'hover:bg-accent',
  danger: 'bg-danger text-white hover:opacity-90',
} as const;
const sizes = {
  default: 'h-9 px-4',
  sm: 'h-8 px-3 text-xs',
  icon: 'h-8 w-8 justify-center',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export function Button({
  className,
  variant = 'default',
  size = 'default',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-md text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
