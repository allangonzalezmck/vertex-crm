'use client';

/**
 * @file frontend/src/app/(dashboard)/dashboard/page.tsx
 * @description Vertex CRM — Lead-to-Customer Journey dashboard.
 * Implements the reference design: KPI strip with period deltas, 12-month
 * multi-series trend, conversion funnel, top leads (last 30 days), and
 * today's follow-up queue. Animated with Framer Motion (spring counters,
 * staggered card entrance); charts use layered gradients for depth.
 */

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { motion, useInView, animate } from 'framer-motion';
import {
  Users, Flame, Gauge, Snowflake, Sprout, CalendarCheck, Trophy, XCircle,
  TrendingUp, ArrowUpRight, ArrowDownRight, Phone, MessageSquare, ChevronRight,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/stores/auth.store';
import { formatNumber, initials } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DashboardData {
  kpis: {
    key: string; label: string; value: number; change: number;
    isPercent?: boolean; isPp?: boolean;
  }[];
  trend: { month: string; newLeads: number; inProgress: number; nurtured: number; won: number; lost: number }[];
  funnel: { label: string; value: number; pct: number }[];
  topLeads: {
    id: string; name: string; source: string; stage: string;
    score: number; lastContact: string; nextFollowUp: string | null;
  }[];
  followUps: { id: string; name: string; stage: string; action: 'call' | 'message'; leadId: string }[];
  comparison: { metric: string; current: string; previous: string; change: string; positive: boolean }[];
}

// ─── Animated counter (springs from 0 to value on first view) ────────────────

function AnimatedNumber({ value, isPercent }: { value: number; isPercent?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(0, value, {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [inView, value]);

  return (
    <span ref={ref}>
      {isPercent ? `${display.toFixed(1)}%` : formatNumber(Math.round(display), true)}
    </span>
  );
}

// ─── KPI card ────────────────────────────────────────────────────────────────

const KPI_ICONS: Record<string, React.ElementType> = {
  total_new: Users, high: Flame, intermediate: Gauge, low: Snowflake,
  nurtured: Sprout, booked: CalendarCheck, won: Trophy, lost: XCircle,
  conversion: TrendingUp,
};

const KPI_COLORS: Record<string, string> = {
  total_new: 'var(--color-brand-600)', high: '#F59E0B', intermediate: '#F97316',
  low: '#3B82F6', nurtured: '#10B981', booked: '#8B5CF6', won: '#059669',
  lost: '#EF4444', conversion: 'var(--color-brand-600)',
};

function KpiCard({ kpi, index }: { kpi: DashboardData['kpis'][number]; index: number }) {
  const Icon = KPI_ICONS[kpi.key] ?? Users;
  const color = KPI_COLORS[kpi.key] ?? 'var(--color-brand-600)';
  const positive = kpi.change >= 0;
  // "Lost" going down is good; flip semantic color for that metric
  const deltaGood = kpi.key === 'lost' ? !positive : positive;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, type: 'spring', stiffness: 260, damping: 24 }}
      whileHover={{ y: -3, boxShadow: '0 12px 24px -8px rgba(79,70,229,0.18)' }}
      className="rounded-2xl p-4 min-w-[150px] flex-shrink-0"
      style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className="p-1.5 rounded-lg" style={{ background: `${color}18` }}>
          <Icon size={14} style={{ color }} />
        </div>
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          {kpi.label}
        </span>
      </div>
      <p className="text-[26px] font-bold leading-none mb-1.5" style={{ color: 'var(--text-primary)' }}>
        <AnimatedNumber value={kpi.value} isPercent={kpi.isPercent} />
      </p>
      <div className="flex items-center gap-1 text-[11px] font-semibold"
        style={{ color: deltaGood ? '#059669' : '#EF4444' }}>
        {positive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
        {Math.abs(kpi.change).toFixed(1)}{kpi.isPp ? ' pp' : '%'}
        <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>vs last 30d</span>
      </div>
    </motion.div>
  );
}

// ─── Conversion funnel (gradient bars with depth bevel) ──────────────────────

const FUNNEL_GRADIENTS = [
  ['#4F46E5', '#6366F1'], ['#6366F1', '#818CF8'], ['#818CF8', '#A5B4FC'], ['#059669', '#10B981'],
];

function ConversionFunnel({ stages }: { stages: DashboardData['funnel'] }) {
  return (
    <div className="rounded-2xl p-5"
      style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)' }}>
      <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
        Conversion Funnel <span className="font-normal text-xs" style={{ color: 'var(--text-tertiary)' }}>(Last 30 Days)</span>
      </h3>
      <div className="space-y-2">
        {stages.map((s, i) => {
          const [from, to] = FUNNEL_GRADIENTS[Math.min(i, FUNNEL_GRADIENTS.length - 1)];
          return (
            <motion.div
              key={s.label}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: `${100 - i * 14}%`, opacity: 1 }}
              transition={{ delay: 0.3 + i * 0.12, type: 'spring', stiffness: 120, damping: 20 }}
              className="relative rounded-lg px-4 py-2.5 flex items-center justify-between overflow-hidden"
              style={{
                background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`,
                boxShadow: `0 4px 10px -3px ${from}66, inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -2px 0 rgba(0,0,0,0.15)`,
              }}
            >
              <span className="text-white text-xs font-semibold z-10">{s.label}</span>
              <div className="flex items-baseline gap-2 z-10">
                <span className="text-white text-sm font-bold">{formatNumber(s.value, true)}</span>
                <span className="text-white/75 text-[10px]">{s.pct}%</span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Score pill ──────────────────────────────────────────────────────────────

function ScorePill({ score }: { score: number }) {
  const color = score >= 70 ? '#059669' : score >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <div className="flex items-center gap-2">
      <div className="w-10 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
        <motion.div initial={{ width: 0 }} animate={{ width: `${score}%` }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
          className="h-full rounded-full" style={{ background: color }} />
      </div>
      <span className="text-xs font-bold" style={{ color }}>{score}</span>
    </div>
  );
}

const STAGE_STYLE: Record<string, string> = {
  'In Progress – High': '#F59E0B', 'In Progress – Intermediate': '#F97316',
  'In Progress – Low': '#3B82F6', Nurtured: '#10B981', 'Booked Trial': '#8B5CF6',
  Won: '#059669', Lost: '#EF4444', New: '#6366F1',
};

function StageBadge({ stage }: { stage: string }) {
  const c = STAGE_STYLE[stage] ?? '#6B7280';
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded"
      style={{ color: c, background: `${c}16` }}>{stage}</span>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => apiFetch('/api/leads/dashboard'),
    refetchInterval: 60_000, // live-ish refresh
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-28 w-40 rounded-2xl animate-pulse flex-shrink-0"
              style={{ background: 'var(--surface-sunken)' }} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 h-72 rounded-2xl animate-pulse" style={{ background: 'var(--surface-sunken)' }} />
          <div className="h-72 rounded-2xl animate-pulse" style={{ background: 'var(--surface-sunken)' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-[1500px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Lead to Customer Journey
          </h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            Live overview · auto-refreshes every 60s
          </p>
        </div>
        <select className="text-xs rounded-lg px-3 py-1.5 border"
          style={{ background: 'var(--surface-card)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
          defaultValue="30d" aria-label="Date range">
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="12m">Last 12 months</option>
        </select>
      </div>

      {/* KPI strip */}
      <div className="flex gap-3 overflow-x-auto pb-1" role="list" aria-label="Key metrics">
        {data.kpis.map((kpi, i) => <KpiCard key={kpi.key} kpi={kpi} index={i} />)}
      </div>

      {/* Trend + Funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="lg:col-span-2 rounded-2xl p-5"
          style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)' }}>
          <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
            Performance Overview <span className="font-normal text-xs" style={{ color: 'var(--text-tertiary)' }}>· Trend per month (12 months)</span>
          </h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <defs>
                {[['gNew', '#4F46E5'], ['gProg', '#F59E0B'], ['gWon', '#059669'], ['gLost', '#EF4444']].map(([id, c]) => (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{
                background: 'var(--surface-card)', border: '1px solid var(--border-default)',
                borderRadius: 12, fontSize: 12,
              }} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7} />
              <Area type="monotone" dataKey="newLeads" name="New Leads" stroke="#4F46E5" strokeWidth={2.5} fill="url(#gNew)" animationDuration={1200} />
              <Area type="monotone" dataKey="inProgress" name="In Progress" stroke="#F59E0B" strokeWidth={2} fill="url(#gProg)" animationDuration={1400} />
              <Area type="monotone" dataKey="won" name="Won" stroke="#059669" strokeWidth={2} fill="url(#gWon)" animationDuration={1600} />
              <Area type="monotone" dataKey="lost" name="Lost" stroke="#EF4444" strokeWidth={2} fill="url(#gLost)" animationDuration={1800} />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        <ConversionFunnel stages={data.funnel} />
      </div>

      {/* Top leads + Follow-ups + Comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Top leads (last 30 days, by score) */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
          className="lg:col-span-2 rounded-2xl overflow-hidden"
          style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)' }}>
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Top Leads <span className="font-normal text-xs" style={{ color: 'var(--text-tertiary)' }}>(Last 30 days · by score)</span>
            </h3>
            <Link href="/leads" className="text-xs font-medium flex items-center gap-0.5"
              style={{ color: 'var(--color-brand-600)' }}>
              View all <ChevronRight size={12} />
            </Link>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr style={{ background: 'var(--surface-sunken)' }}>
                {['Lead', 'Source', 'Stage', 'Last Contact', 'Next Follow-up', 'Score'].map((h) => (
                  <th key={h} className="px-5 py-2 text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.topLeads.map((lead, i) => (
                <motion.tr key={lead.id}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.35 + i * 0.04 }}
                  className="border-t hover:bg-[var(--surface-sunken)] transition-colors cursor-pointer"
                  style={{ borderColor: 'var(--border-default)' }}>
                  <td className="px-5 py-2.5">
                    <Link href={`/leads/${lead.id}`} className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                        style={{ background: 'var(--color-brand-600)' }}>
                        {initials(lead.name)}
                      </div>
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{lead.name}</span>
                    </Link>
                  </td>
                  <td className="px-5 py-2.5 text-xs capitalize" style={{ color: 'var(--text-secondary)' }}>{lead.source}</td>
                  <td className="px-5 py-2.5"><StageBadge stage={lead.stage} /></td>
                  <td className="px-5 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{lead.lastContact}</td>
                  <td className="px-5 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{lead.nextFollowUp ?? '—'}</td>
                  <td className="px-5 py-2.5"><ScorePill score={lead.score} /></td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </motion.div>

        {/* Right rail: follow-ups + comparison */}
        <div className="space-y-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
            className="rounded-2xl p-5"
            style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)' }}>
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
              Next Follow-Ups
            </h3>
            <div className="space-y-2.5">
              {data.followUps.map((f) => (
                <div key={f.id} className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{f.name}</p>
                    <StageBadge stage={f.stage} />
                  </div>
                  <Link href={`/leads/${f.leadId}`}
                    className="flex items-center gap-1 text-[10px] font-bold text-white rounded-lg px-2.5 py-1.5 flex-shrink-0"
                    style={{ background: f.action === 'call' ? 'var(--color-brand-600)' : '#10B981' }}>
                    {f.action === 'call' ? <Phone size={10} /> : <MessageSquare size={10} />}
                    {f.action === 'call' ? 'Call' : 'Message'}
                  </Link>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
            className="rounded-2xl p-5"
            style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)' }}>
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
              vs Last 30 Days
            </h3>
            <table className="w-full text-[11px]">
              <tbody>
                {data.comparison.map((row) => (
                  <tr key={row.metric} className="border-t" style={{ borderColor: 'var(--border-default)' }}>
                    <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{row.metric}</td>
                    <td className="py-1.5 font-bold text-right" style={{ color: 'var(--text-primary)' }}>{row.current}</td>
                    <td className="py-1.5 text-right font-semibold"
                      style={{ color: row.positive ? '#059669' : '#EF4444' }}>{row.change}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
