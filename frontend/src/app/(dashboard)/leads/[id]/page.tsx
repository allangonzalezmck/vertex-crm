'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Phone, Mail, MessageCircle, Calendar, Edit2,
  Clock, User, Tag, TrendingUp, ChevronDown, ChevronUp,
  CheckCircle, AlertCircle, Info, Zap, FileText, Star
} from 'lucide-react';
import { apiFetch, formatDateTime, formatRelativeTime, formatCurrency, initials, LEAD_STATUS_LABELS, LEAD_STATUS_COLORS, ACTIVITY_TYPE_ICONS } from '@/lib/utils';
import { Button, Badge, Modal, toast } from '@/components/aura';

// ── Types ────────────────────────────────────────────────────────────────────
interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  company: string | null;
  title: string | null;
  status: string;
  score: number;
  source: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface TimelineEvent {
  type: 'activity' | 'status_change' | 'note' | 'ai_conversation' | 'email';
  id: string;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  userId?: string;
  userName?: string;
}

interface Activity {
  id: string;
  type: string;
  subject: string;
  dueAt: string | null;
  completedAt: string | null;
  notes: string | null;
}

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_FLOW = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;

// ── Timeline item ─────────────────────────────────────────────────────────────
function TimelineItem({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = useState(false);

  const icon = () => {
    switch (event.type) {
      case 'activity':        return <Zap size={14} />;
      case 'status_change':   return <TrendingUp size={14} />;
      case 'note':            return <FileText size={14} />;
      case 'ai_conversation': return <MessageCircle size={14} />;
      case 'email':           return <Mail size={14} />;
      default:                return <Info size={14} />;
    }
  };

  const iconBg = {
    activity:        'var(--color-primary)',
    status_change:   'var(--color-chart-2)',
    note:            'var(--color-muted-fg)',
    ai_conversation: 'var(--color-chart-3)',
    email:           'var(--color-chart-4)',
  }[event.type] ?? 'var(--color-border)';

  return (
    <div className="flex gap-3 group">
      {/* Line + dot */}
      <div className="flex flex-col items-center">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-white flex-shrink-0"
          style={{ background: iconBg }}
        >
          {icon()}
        </div>
        <div className="w-px flex-1 mt-1" style={{ background: 'var(--color-border)' }} />
      </div>

      {/* Content */}
      <div className="pb-5 flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--color-fg)' }}>
              {event.title}
            </p>
            {event.userName && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-muted-fg)' }}>
                by {event.userName}
              </p>
            )}
          </div>
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--color-muted-fg)' }}>
            {formatRelativeTime(event.createdAt)}
          </span>
        </div>

        {event.body && (
          <div className="mt-2">
            <p
              className="text-sm leading-relaxed"
              style={{
                color: 'var(--color-muted-fg)',
                display: '-webkit-box',
                WebkitLineClamp: expanded ? 'unset' : 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {event.body}
            </p>
            {event.body.length > 200 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs mt-1 flex items-center gap-1"
                style={{ color: 'var(--color-primary)' }}
              >
                {expanded ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> Show more</>}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Score bar ─────────────────────────────────────────────────────────────────
function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? 'var(--color-chart-2)' : score >= 40 ? 'var(--color-chart-5)' : 'var(--color-chart-1)';
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-medium" style={{ color: 'var(--color-muted-fg)' }}>Lead Score</span>
        <span className="text-sm font-semibold" style={{ color }}>{score}/100</span>
      </div>
      <div className="h-2 rounded-full" style={{ background: 'var(--color-border)' }}>
        <motion.div
          className="h-2 rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<'timeline' | 'activities' | 'conversations'>('timeline');
  const [noteText, setNoteText] = useState('');

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: lead, isLoading: leadLoading } = useQuery<Lead>({
    queryKey: ['lead', id],
    queryFn: () => apiFetch(`/api/leads/${id}`),
  });

  const { data: timelineData } = useQuery<{ events: TimelineEvent[] }>({
    queryKey: ['lead-timeline', id],
    queryFn: () => apiFetch(`/api/leads/${id}/timeline`),
    enabled: !!lead,
  });

  const { data: activitiesData } = useQuery<{ activities: Activity[] }>({
    queryKey: ['lead-activities', id],
    queryFn: () => apiFetch(`/api/activities?leadId=${id}&limit=20`),
    enabled: !!lead && activityTab === 'activities',
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const updateStatus = useMutation({
    mutationFn: (status: string) =>
      apiFetch(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead', id] });
      qc.invalidateQueries({ queryKey: ['lead-timeline', id] });
      toast.success('Status updated');
    },
  });

  const convertLead = useMutation({
    mutationFn: () => apiFetch(`/api/leads/${id}/convert`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Lead converted to Contact + Account + Deal!');
      qc.invalidateQueries({ queryKey: ['lead', id] });
    },
    onError: () => toast.error('Conversion failed'),
  });

  const addNote = useMutation({
    mutationFn: () =>
      apiFetch(`/api/activities`, {
        method: 'POST',
        body: JSON.stringify({ leadId: id, type: 'note', subject: 'Note', notes: noteText }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-timeline', id] });
      setNoteText('');
      setNoteOpen(false);
      toast.success('Note added');
    },
  });

  // ── Loading ────────────────────────────────────────────────────────────────
  if (leadLoading) {
    return (
      <div className="p-8 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--color-surface-2)' }} />
        ))}
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-8 text-center">
        <AlertCircle size={40} className="mx-auto mb-3" style={{ color: 'var(--color-muted-fg)' }} />
        <p style={{ color: 'var(--color-fg)' }}>Lead not found</p>
        <Button variant="ghost" onClick={() => router.back()} className="mt-3">Go back</Button>
      </div>
    );
  }

  const fullName = `${lead.firstName} ${lead.lastName}`;
  const statusColor = LEAD_STATUS_COLORS[lead.status] ?? '#6b7280';

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-lg transition-colors"
          style={{ color: 'var(--color-muted-fg)', background: 'transparent' }}
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold truncate" style={{ color: 'var(--color-fg)' }}>
            {fullName}
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-muted-fg)' }}>
            {lead.title && `${lead.title} · `}{lead.company ?? 'No company'} · Added {formatRelativeTime(lead.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" icon={<Edit2 size={14} />} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<CheckCircle size={14} />}
            onClick={() => convertLead.mutate()}
            loading={convertLead.isPending}
            disabled={lead.status === 'won' || lead.status === 'lost'}
          >
            Convert
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* ── Left column: details ── */}
        <div className="col-span-1 space-y-4">
          {/* Avatar + quick actions */}
          <div
            className="rounded-2xl p-5 space-y-4"
            style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}
          >
            <div className="flex flex-col items-center text-center">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold text-white mb-3"
                style={{ background: 'var(--color-primary)' }}
              >
                {initials(fullName)}
              </div>
              <h2 className="font-semibold" style={{ color: 'var(--color-fg)' }}>{fullName}</h2>
              <Badge
                variant="outline"
                className="mt-1"
                style={{ color: statusColor, borderColor: statusColor }}
              >
                {LEAD_STATUS_LABELS[lead.status] ?? lead.status}
              </Badge>
            </div>

            <ScoreBar score={lead.score} />

            <div className="flex gap-2">
              {lead.phone && (
                <a
                  href={`tel:${lead.phone}`}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-fg)' }}
                >
                  <Phone size={14} /> Call
                </a>
              )}
              <a
                href={`mailto:${lead.email}`}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--color-surface-2)', color: 'var(--color-fg)' }}
              >
                <Mail size={14} /> Email
              </a>
            </div>
          </div>

          {/* Contact info */}
          <div
            className="rounded-2xl p-5 space-y-3"
            style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}
          >
            <h3 className="text-sm font-semibold" style={{ color: 'var(--color-fg)' }}>Contact Info</h3>
            {[
              { icon: Mail, label: 'Email', value: lead.email },
              { icon: Phone, label: 'Phone', value: lead.phone },
              { icon: User, label: 'Assigned', value: lead.assignedToName },
              { icon: Tag, label: 'Source', value: lead.source },
            ].filter((r) => r.value).map((row) => (
              <div key={row.label} className="flex items-center gap-3">
                <row.icon size={14} style={{ color: 'var(--color-muted-fg)' }} className="flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs" style={{ color: 'var(--color-muted-fg)' }}>{row.label}</p>
                  <p className="text-sm truncate" style={{ color: 'var(--color-fg)' }}>{row.value}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Status pipeline */}
          <div
            className="rounded-2xl p-5"
            style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}
          >
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-fg)' }}>Pipeline Stage</h3>
            <div className="space-y-1">
              {STATUS_FLOW.map((s) => {
                const isActive = lead.status === s;
                const isPast = STATUS_FLOW.indexOf(s) < STATUS_FLOW.indexOf(lead.status as any);
                return (
                  <button
                    key={s}
                    onClick={() => !isActive && updateStatus.mutate(s)}
                    disabled={updateStatus.isPending}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors"
                    style={{
                      background: isActive ? 'var(--color-primary)' : 'transparent',
                      color: isActive ? '#fff' : isPast ? 'var(--color-primary)' : 'var(--color-muted-fg)',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {isPast && <CheckCircle size={12} />}
                    {isActive && <Star size={12} />}
                    {!isPast && !isActive && <div className="w-3 h-3 rounded-full border" style={{ borderColor: 'currentColor' }} />}
                    {LEAD_STATUS_LABELS[s] ?? s}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Right column: timeline ── */}
        <div className="col-span-2 space-y-4">
          {/* Quick note */}
          <div
            className="rounded-2xl p-4"
            style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}
          >
            <button
              onClick={() => setNoteOpen(true)}
              className="w-full text-left px-4 py-2.5 rounded-xl text-sm"
              style={{
                background: 'var(--color-surface-2)',
                color: 'var(--color-muted-fg)',
                border: '1px solid var(--color-border)',
              }}
            >
              Add a note, log a call...
            </button>
          </div>

          {/* Tabs */}
          <div
            className="rounded-2xl"
            style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}
          >
            <div className="flex border-b" style={{ borderColor: 'var(--color-border)' }}>
              {(['timeline', 'activities', 'conversations'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActivityTab(tab)}
                  className="px-5 py-3 text-sm font-medium capitalize transition-colors"
                  style={{
                    color: activityTab === tab ? 'var(--color-primary)' : 'var(--color-muted-fg)',
                    borderBottom: activityTab === tab ? '2px solid var(--color-primary)' : '2px solid transparent',
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="p-5">
              <AnimatePresence mode="wait">
                {activityTab === 'timeline' && (
                  <motion.div
                    key="timeline"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    {timelineData?.events?.length ? (
                      <div>
                        {timelineData.events.map((ev) => (
                          <TimelineItem key={ev.id} event={ev} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-center py-8" style={{ color: 'var(--color-muted-fg)' }}>
                        No activity yet
                      </p>
                    )}
                  </motion.div>
                )}

                {activityTab === 'activities' && (
                  <motion.div
                    key="activities"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="space-y-2"
                  >
                    {activitiesData?.activities?.map((act) => (
                      <div
                        key={act.id}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                        style={{ background: 'var(--color-surface-2)' }}
                      >
                        <span className="text-lg">{ACTIVITY_TYPE_ICONS[act.type] ?? '📌'}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: 'var(--color-fg)' }}>
                            {act.subject}
                          </p>
                          {act.dueAt && (
                            <p className="text-xs" style={{ color: 'var(--color-muted-fg)' }}>
                              Due {formatDateTime(act.dueAt)}
                            </p>
                          )}
                        </div>
                        {act.completedAt && (
                          <CheckCircle size={14} style={{ color: 'var(--color-chart-2)' }} />
                        )}
                      </div>
                    )) ?? (
                      <p className="text-sm text-center py-8" style={{ color: 'var(--color-muted-fg)' }}>
                        No activities
                      </p>
                    )}
                  </motion.div>
                )}

                {activityTab === 'conversations' && (
                  <motion.div
                    key="conversations"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <p className="text-sm text-center py-8" style={{ color: 'var(--color-muted-fg)' }}>
                      AI conversation history will appear here
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* ── Add note modal ── */}
      <Modal open={noteOpen} onClose={() => setNoteOpen(false)} title="Add Note">
        <div className="space-y-4">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Write your note..."
            rows={5}
            className="w-full px-3 py-2 rounded-xl text-sm resize-none"
            style={{
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-fg)',
              outline: 'none',
            }}
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => addNote.mutate()}
              loading={addNote.isPending}
              disabled={!noteText.trim()}
            >
              Save Note
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
