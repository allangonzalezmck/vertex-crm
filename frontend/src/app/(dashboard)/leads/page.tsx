'use client';

/**
 * @file frontend/src/app/(dashboard)/leads/page.tsx
 * @description Leads list page — searchable, filterable DataTable with
 * bulk actions, status badges, and inline quick-actions.
 */

import React, { useState, useCallback } from 'react';
import {
  Search, Plus, Filter, Download, Upload, RefreshCw,
  MoreHorizontal, Phone, Mail, Eye, Trash2, ArrowUpDown,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Badge, Input, Select, toast } from '@/components/aura';
import {
  formatDate, formatRelativeTime, LEAD_STATUS_LABELS, LEAD_STATUS_COLORS,
  buildQueryString, truncate,
} from '@/lib/utils';
import { apiFetch } from '@/stores/auth.store';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  company?: string;
  status: string;
  source?: string;
  score?: number;
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
}

interface LeadsResponse {
  data: {
    items: Lead[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

const STATUS_BADGE_VARIANTS: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  new: 'default',
  contacted: 'warning',
  qualified: 'success',
  disqualified: 'neutral',
  converted: 'info' as any,
};

function LeadStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_BADGE_VARIANTS[status] ?? 'neutral'} dot size="sm">
      {LEAD_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

// ─── Score Indicator ──────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? 'var(--color-green-500)' : score >= 40 ? 'var(--color-amber-500)' : 'var(--color-danger-400)';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-[var(--surface-base)]">
        <div className="h-full rounded-full" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="text-[12px] font-medium text-[var(--text-secondary)]">{score}</span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const queryClient = useQueryClient();

  // Filter state
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ field: string; order: 'asc' | 'desc' }>({ field: 'createdAt', order: 'desc' });

  const queryParams = {
    ...(search && { q: search }),
    ...(status && { status }),
    ...(source && { source }),
    page,
    limit: 25,
    sort: sort.field,
    order: sort.order,
  };

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['leads', queryParams],
    queryFn: () => apiFetch<LeadsResponse>(`/api/v1/leads${buildQueryString(queryParams)}`),
    staleTime: 30_000,
  });

  const leads = data?.data?.items ?? [];
  const pagination = data?.data?.pagination;

  // Bulk delete
  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map(id => apiFetch(`/api/v1/leads/${id}`, { method: 'DELETE' }))),
    onSuccess: () => {
      toast.success('Leads deleted', `${selectedIds.size} lead(s) removed`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: () => toast.error('Delete failed', 'Could not delete selected leads'),
  });

  // Selection helpers
  const allSelected = leads.length > 0 && leads.every(l => selectedIds.has(l.id));
  const someSelected = selectedIds.size > 0;

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(leads.map(l => l.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSort = (field: string) => {
    setSort(prev =>
      prev.field === field
        ? { field, order: prev.order === 'asc' ? 'desc' : 'asc' }
        : { field, order: 'desc' }
    );
    setPage(1);
  };

  const SortButton = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <button
      onClick={() => handleSort(field)}
      className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors"
    >
      {children}
      <ArrowUpDown size={11} className={sort.field === field ? 'opacity-100' : 'opacity-30'} />
    </button>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Page Header */}
      <div className="px-6 py-4 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[18px] font-bold text-[var(--text-primary)]">Leads</h1>
            {pagination && (
              <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                {pagination.total.toLocaleString()} total leads
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" leftIcon={<Upload size={13} />}>Import</Button>
            <Button variant="secondary" size="sm" leftIcon={<Download size={13} />}>Export</Button>
            <Button size="sm" leftIcon={<Plus size={13} />} onClick={() => {}}>Add Lead</Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mt-4">
          <div className="flex-1 max-w-sm">
            <Input
              placeholder="Search leads…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              leftIcon={<Search size={14} />}
            />
          </div>
          <Select
            options={[
              { value: '', label: 'All statuses' },
              { value: 'new', label: 'New' },
              { value: 'contacted', label: 'Contacted' },
              { value: 'qualified', label: 'Qualified' },
              { value: 'disqualified', label: 'Disqualified' },
            ]}
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1); }}
            className="w-40"
          />
          <Select
            options={[
              { value: '', label: 'All sources' },
              { value: 'website', label: 'Website' },
              { value: 'linkedin', label: 'LinkedIn' },
              { value: 'referral', label: 'Referral' },
              { value: 'cold_outreach', label: 'Cold Outreach' },
              { value: 'ai_agent', label: 'AI Agent' },
            ]}
            value={source}
            onChange={e => { setSource(e.target.value); setPage(1); }}
            className="w-40"
          />
          <button
            onClick={() => refetch()}
            className="p-2 rounded-[var(--radius-md)] border border-[var(--border-default)]
                       text-[var(--text-tertiary)] hover:text-[var(--text-primary)]
                       hover:bg-[var(--surface-sidebar-item-hover)]
                       transition-colors duration-[var(--transition-fast)]"
            aria-label="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Bulk Actions Bar */}
        {someSelected && (
          <div className="flex items-center gap-3 mt-3 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-brand-50)] border border-[var(--color-brand-200)]">
            <span className="text-[13px] font-medium text-[var(--color-brand-700)]">
              {selectedIds.size} selected
            </span>
            <Button
              variant="danger"
              size="sm"
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate([...selectedIds])}
            >
              Delete
            </Button>
            <Button variant="secondary" size="sm">Change Status</Button>
            <Button variant="secondary" size="sm">Assign Owner</Button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="ml-auto text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 z-10 bg-[var(--surface-card)] border-b border-[var(--border-subtle)]">
            <tr>
              <th className="w-10 px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded border-[var(--border-default)]"
                  aria-label="Select all"
                />
              </th>
              <th className="px-3 py-3 text-left font-medium text-[var(--text-tertiary)] whitespace-nowrap">
                <SortButton field="lastName">Name</SortButton>
              </th>
              <th className="px-3 py-3 text-left font-medium text-[var(--text-tertiary)]">Company</th>
              <th className="px-3 py-3 text-left font-medium text-[var(--text-tertiary)]">Status</th>
              <th className="px-3 py-3 text-left font-medium text-[var(--text-tertiary)]">Score</th>
              <th className="px-3 py-3 text-left font-medium text-[var(--text-tertiary)] whitespace-nowrap">
                <SortButton field="createdAt">Created</SortButton>
              </th>
              <th className="px-3 py-3 text-left font-medium text-[var(--text-tertiary)]">Owner</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>

          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border-subtle)]">
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-3 py-3">
                      <div className="h-4 rounded bg-[var(--surface-base)] animate-pulse" style={{ width: j === 0 ? '24px' : '80%' }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-16 text-center text-[var(--text-tertiary)]">
                  <Search size={28} className="mx-auto mb-2 opacity-40" />
                  <p className="text-[14px]">No leads found</p>
                  <p className="text-[12px] mt-1">Try adjusting your filters</p>
                </td>
              </tr>
            ) : (
              leads.map(lead => (
                <tr
                  key={lead.id}
                  className={`border-b border-[var(--border-subtle)] hover:bg-[var(--surface-sidebar-item-hover)]
                              transition-colors duration-[var(--transition-fast)] group
                              ${selectedIds.has(lead.id) ? 'bg-[var(--color-brand-50)]' : ''}`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(lead.id)}
                      onChange={() => toggleOne(lead.id)}
                      className="rounded border-[var(--border-default)]"
                      aria-label={`Select ${lead.firstName} ${lead.lastName}`}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-[var(--color-brand-400)] to-[var(--color-brand-600)] flex items-center justify-center">
                        <span className="text-white text-[11px] font-bold">
                          {lead.firstName[0]}{lead.lastName[0]}
                        </span>
                      </div>
                      <div>
                        <a
                          href={`/leads/${lead.id}`}
                          className="font-medium text-[var(--text-primary)] hover:text-[var(--color-brand-600)] transition-colors"
                        >
                          {lead.firstName} {lead.lastName}
                        </a>
                        {lead.email && (
                          <p className="text-[11px] text-[var(--text-tertiary)] truncate max-w-[180px]">{lead.email}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-[var(--text-secondary)]">
                    {truncate(lead.company ?? '—', 28)}
                  </td>
                  <td className="px-3 py-3">
                    <LeadStatusBadge status={lead.status} />
                  </td>
                  <td className="px-3 py-3">
                    {lead.score != null ? <ScoreBar score={lead.score} /> : <span className="text-[var(--text-tertiary)]">—</span>}
                  </td>
                  <td className="px-3 py-3 text-[var(--text-tertiary)] whitespace-nowrap">
                    {formatRelativeTime(lead.createdAt)}
                  </td>
                  <td className="px-3 py-3 text-[var(--text-secondary)]">
                    {lead.ownerName ?? '—'}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <a
                        href={`/leads/${lead.id}`}
                        className="p-1.5 rounded hover:bg-[var(--action-ghost-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        title="View lead"
                      >
                        <Eye size={13} />
                      </a>
                      {lead.phone && (
                        <a
                          href={`tel:${lead.phone}`}
                          className="p-1.5 rounded hover:bg-[var(--action-ghost-hover)] text-[var(--text-tertiary)] hover:text-[var(--color-green-600)]"
                          title="Call"
                        >
                          <Phone size={13} />
                        </a>
                      )}
                      {lead.email && (
                        <a
                          href={`mailto:${lead.email}`}
                          className="p-1.5 rounded hover:bg-[var(--action-ghost-hover)] text-[var(--text-tertiary)] hover:text-[var(--color-blue-600)]"
                          title="Email"
                        >
                          <Mail size={13} />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="px-6 py-3 border-t border-[var(--border-subtle)] bg-[var(--surface-card)] flex items-center justify-between">
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Showing {((page - 1) * 25) + 1}–{Math.min(page * 25, pagination.total)} of {pagination.total.toLocaleString()}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
              leftIcon={<ChevronLeft size={13} />}
            >
              Prev
            </Button>
            <span className="px-3 py-1 text-[12px] text-[var(--text-secondary)]">
              {page} / {pagination.totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page === pagination.totalPages}
              onClick={() => setPage(p => p + 1)}
              rightIcon={<ChevronRight size={13} />}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
