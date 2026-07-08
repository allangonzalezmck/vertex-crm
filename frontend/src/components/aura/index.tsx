'use client';

/**
 * @file frontend/src/components/aura/index.ts
 * @description Barrel export for all Aura design system components.
 * Re-exports Button, Sidebar, and all components defined below.
 */

// ─── Re-exports ───────────────────────────────────────────────────────────────
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';
export { Sidebar } from './Sidebar';

// ─── Badge ────────────────────────────────────────────────────────────────────

import React from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}

const badgeVariantStyles: Record<BadgeVariant, string> = {
  default:  'bg-[var(--color-brand-100)] text-[var(--color-brand-700)]',
  success:  'bg-[var(--color-green-100)] text-[var(--color-green-700)]',
  warning:  'bg-[var(--color-amber-100)] text-[var(--color-amber-700)]',
  danger:   'bg-[var(--color-danger-100)] text-[var(--color-danger-700)]',
  info:     'bg-[var(--color-blue-100)] text-[var(--color-blue-700)]',
  neutral:  'bg-[var(--color-gray-100)] text-[var(--color-gray-600)]',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-[var(--color-brand-500)]',
  success: 'bg-[var(--color-green-500)]',
  warning: 'bg-[var(--color-amber-500)]',
  danger:  'bg-[var(--color-danger-500)]',
  info:    'bg-[var(--color-blue-500)]',
  neutral: 'bg-[var(--color-gray-400)]',
};

export function Badge({ variant = 'default', size = 'md', dot, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-medium rounded-full',
        size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-[12px] px-2.5 py-1',
        badgeVariantStyles[variant],
        className
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColors[variant])} />}
      {children}
    </span>
  );
}

// ─── Input ────────────────────────────────────────────────────────────────────

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightElement?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leftIcon, rightElement, className, id, ...props },
  ref
) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="text-[13px] font-medium text-[var(--text-primary)]"
        >
          {label}
          {props.required && <span className="ml-0.5 text-[var(--color-danger-500)]">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        {leftIcon && (
          <span className="absolute left-3 text-[var(--text-tertiary)] pointer-events-none flex items-center">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'w-full h-9 rounded-[var(--radius-md)] border text-[14px]',
            'bg-[var(--surface-input)] text-[var(--text-primary)]',
            'placeholder:text-[var(--text-placeholder)]',
            'transition-[border-color,box-shadow] duration-[var(--transition-fast)]',
            'focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--border-focus)] focus:ring-opacity-20',
            error
              ? 'border-[var(--color-danger-400)] focus:border-[var(--color-danger-500)] focus:ring-[var(--color-danger-200)]'
              : 'border-[var(--border-default)] hover:border-[var(--border-hover)]',
            leftIcon ? 'pl-9' : 'pl-3',
            rightElement ? 'pr-10' : 'pr-3',
            props.disabled && 'opacity-50 cursor-not-allowed bg-[var(--surface-disabled)]',
            className
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {rightElement && (
          <span className="absolute right-3 text-[var(--text-tertiary)] flex items-center">
            {rightElement}
          </span>
        )}
      </div>
      {error && (
        <p id={`${inputId}-error`} className="text-[12px] text-[var(--color-danger-600)]" role="alert">
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={`${inputId}-hint`} className="text-[12px] text-[var(--text-tertiary)]">
          {hint}
        </p>
      )}
    </div>
  );
});

// ─── Select ───────────────────────────────────────────────────────────────────

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, placeholder, className, id, ...props },
  ref
) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="text-[13px] font-medium text-[var(--text-primary)]">
          {label}
          {props.required && <span className="ml-0.5 text-[var(--color-danger-500)]">*</span>}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        className={cn(
          'w-full h-9 pl-3 pr-8 rounded-[var(--radius-md)] border text-[14px]',
          'bg-[var(--surface-input)] text-[var(--text-primary)]',
          'appearance-none cursor-pointer',
          'transition-[border-color,box-shadow] duration-[var(--transition-fast)]',
          'focus:outline-none focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--border-focus)] focus:ring-opacity-20',
          error
            ? 'border-[var(--color-danger-400)]'
            : 'border-[var(--border-default)] hover:border-[var(--border-hover)]',
          props.disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        aria-invalid={!!error}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 10px center',
        }}
        {...props}
      >
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {options.map(opt => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <p className="text-[12px] text-[var(--color-danger-600)]" role="alert">{error}</p>}
      {hint && !error && <p className="text-[12px] text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  );
});

// ─── Modal ────────────────────────────────────────────────────────────────────

import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children: React.ReactNode;
  footer?: React.ReactNode;
}

const modalSizes = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
};

export function Modal({ open, onClose, title, description, size = 'md', children, footer }: ModalProps) {
  // Close on Escape
  React.useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className={cn(
              'relative w-full rounded-[var(--radius-lg)]',
              'bg-[var(--surface-card)] shadow-[var(--shadow-xl)]',
              'flex flex-col',
              modalSizes[size]
            )}
          >
            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b border-[var(--border-subtle)]">
              <div>
                <h2 id="modal-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
                  {title}
                </h2>
                {description && (
                  <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{description}</p>
                )}
              </div>
              <button
                onClick={onClose}
                className="ml-4 p-1 rounded-[var(--radius-sm)] text-[var(--text-tertiary)]
                           hover:bg-[var(--action-ghost-hover)] hover:text-[var(--text-primary)]
                           transition-colors duration-[var(--transition-fast)]"
                aria-label="Close modal"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {children}
            </div>

            {/* Footer */}
            {footer && (
              <div className="flex items-center justify-end gap-2 p-4 border-t border-[var(--border-subtle)]">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface ToastData {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
}

import { CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { create } from 'zustand';

interface ToastStore {
  toasts: ToastData[];
  add: (toast: Omit<ToastData, 'id'>) => void;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add: (toast) => {
    const id = Math.random().toString(36).slice(2);
    set(s => ({ toasts: [...s.toasts, { ...toast, id }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 4000);
  },
  remove: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

/** Toast notification helpers */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: 'success', title, description }),
  error: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: 'error', title, description }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: 'warning', title, description }),
  info: (title: string, description?: string) =>
    useToastStore.getState().add({ variant: 'info', title, description }),
};

const toastIcons: Record<ToastVariant, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-[var(--color-green-500)]" />,
  error:   <AlertCircle size={16} className="text-[var(--color-danger-500)]" />,
  warning: <AlertTriangle size={16} className="text-[var(--color-amber-500)]" />,
  info:    <Info size={16} className="text-[var(--color-blue-500)]" />,
};

export function ToastContainer() {
  const { toasts, remove } = useToastStore();

  return (
    <div
      className="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-label="Notifications"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            className="pointer-events-auto flex items-start gap-3 min-w-[300px] max-w-[400px]
                       p-3.5 rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)]
                       bg-[var(--surface-card)] border border-[var(--border-default)]"
            role="alert"
          >
            <span className="flex-shrink-0 mt-0.5">{toastIcons[t.variant]}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-[var(--text-primary)]">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{t.description}</p>
              )}
            </div>
            <button
              onClick={() => remove(t.id)}
              className="flex-shrink-0 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
