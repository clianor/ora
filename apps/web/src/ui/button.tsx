import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn.ts';

const buttonVariants = cva(
  'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-sm px-3 text-[13px] leading-[18px] transition-colors duration-(--duration-fast) ease-(--ease-out) disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-primary font-semibold text-primary-foreground hover:bg-foreground-muted',
        secondary: 'bg-surface-hover font-medium text-foreground hover:bg-surface',
        ghost: 'font-medium text-foreground-muted hover:bg-surface-hover',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export function KeyHint({ children }: { children: string }) {
  return (
    <span className="font-mono text-[11px] leading-[14px] font-medium opacity-70">{children}</span>
  );
}
