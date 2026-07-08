/**
 * @file frontend/src/lib/utils.ts
 * @description Shared utility functions used across the Vertex CRM frontend.
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// ─── Class Name Merge ─────────────────────────────────────────────────────────

/** Merge Tailwind classes without conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const CURRENCY_FORMATTERS: Record<string, Intl.NumberFormat> = {};

export function formatCurrency(
  value: number | null | undefined,
  currency = 'USD',
  compact = false
): string {
  if (value == null) return '—';
  const key = `${currency}-${compact}`;
  if (!CURRENCY_FORMATTERS[key]) {
    CURRENCY_FORMATTERS[key] = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 0,
    });
  }
  return CURRENCY_FORMATTERS[key].format(value);
}

export function formatNumber(value: number | null | undefined, compact = false): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value == null) return '—';
  return `${value.toFixed(decimals)}%`;
}

// ─── Date / Time ─────────────────────────────────────────────────────────────

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const DATE_SHORT_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DATETIME_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try { return DATE_FMT.format(new Date(value)); } catch { return '—'; }
}

export function formatDateShort(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try { return DATE_SHORT_FMT.format(new Date(value)); } catch { return '—'; }
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try { return DATETIME_FMT.format(new Date(value)); } catch { return '—'; }
}

/** Returns "2 hours ago", "3 days ago", etc. */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try {
    const date = new Date(value);
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    if (diffWeek < 5) return `${diffWeek}w ago`;
    if (diffMonth < 12) return `${diffMonth}mo ago`;
    return formatDate(value);
  } catch { return '—'; }
}

export function isOverdue(date: string | Date | null | undefined): boolean {
  if (!date) return false;
  return new Date(date) < new Date();
}

// ─── String Utilities ─────────────────────────────────────────────────────────

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1)}…`;
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join('');
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Lead / Deal Status ───────────────────────────────────────────────────────

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  disqualified: 'Disqualified',
  converted: 'Converted',
};

export const LEAD_STATUS_COLORS: Record<string, string> = {
  new: 'var(--color-brand-600)',
  contacted: 'var(--color-amber-600)',
  qualified: 'var(--color-green-600)',
  disqualified: 'var(--color-gray-400)',
  converted: 'var(--color-purple-600)',
};

export const ACTIVITY_TYPE_ICONS: Record<string, string> = {
  call: '📞',
  email: '📧',
  meeting: '🤝',
  task: '✅',
  note: '📝',
  sms: '💬',
  demo: '🖥️',
};

// ─── API Helpers ──────────────────────────────────────────────────────────────

export function buildQueryString(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, String(v)]);
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}

// ─── Type Guards ──────────────────────────────────────────────────────────────

export function isNonNull<T>(value: T | null | undefined): value is T {
  return value != null;
}

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}
