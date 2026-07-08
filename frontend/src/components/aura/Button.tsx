'use client';

/**
 * @file frontend/src/components/aura/Button.tsx
 * @description Aura Button component — all variants, sizes, loading states.
 * Fully keyboard accessible. Animated with Framer Motion (spring tap).
 */

import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Fills parent width */
  fullWidth?: boolean;
}

// ─── Style Maps ──────────────────────────────────────────────────────────────

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    'bg-[var(--action-primary)] text-[var(--action-primary-text)]',
    'hover:bg-[var(--action-primary-hover)]',
    'active:bg-[var(--action-primary-active)]',
    'focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' '),

  secondary: [
    'bg-[var(--action-secondary)] text-[var(--action-secondary-text)]',
    'hover:bg-[var(--action-secondary-hover)]',
    'border border-[var(--border-default)]',
    'focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' '),

  ghost: [
    'bg-transparent text-[var(--text-primary)]',
    'hover:bg-[var(--action-ghost-hover)]',
    'focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' '),

  danger: [
    'bg-[var(--action-danger)] text-white',
    'hover:bg-[var(--action-danger-hover)]',
    'focus-visible:ring-2 focus-visible:ring-[var(--color-danger-500)] focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' '),

  outline: [
    'bg-transparent text-[var(--action-primary)]',
    'border border-[var(--action-primary)]',
    'hover:bg-[var(--color-brand-50)]',
    'focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] focus-visible:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' '),
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[var(--radius-sm)]',
  md: 'h-9 px-4 text-[14px] gap-2 rounded-[var(--radius-md)]',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-[var(--radius-md)]',
};

// ─── Component ───────────────────────────────────────────────────────────────

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    ...props
  },
  ref
) {
  const isDisabled = disabled || loading;

  return (
    <motion.button
      ref={ref}
      whileTap={isDisabled ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={cn(
        'inline-flex items-center justify-center',
        'font-medium',
        'transition-colors duration-[var(--transition-fast)]',
        'select-none',
        'whitespace-nowrap',
        variantStyles[variant],
        sizeStyles[size],
        fullWidth && 'w-full',
        isDisabled && 'pointer-events-none',
        className
      )}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={loading}
      {...props}
    >
      {loading ? (
        <Loader2
          className="animate-spin"
          style={{ width: size === 'sm' ? 12 : 14, height: size === 'sm' ? 12 : 14 }}
          aria-hidden="true"
        />
      ) : leftIcon ? (
        <span className="flex-shrink-0" aria-hidden="true">
          {leftIcon}
        </span>
      ) : null}

      {children && (
        <span className={cn(loading && 'opacity-0')}>{children}</span>
      )}

      {rightIcon && !loading && (
        <span className="flex-shrink-0" aria-hidden="true">
          {rightIcon}
        </span>
      )}
    </motion.button>
  );
});

Button.displayName = 'Button';
