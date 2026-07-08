/**
 * @file shared/src/types/index.ts
 * @description Core TypeScript types shared across all Vertex CRM services.
 * All domain types derive from these primitives. No `any` types permitted.
 */

// ─── Primitive Branded Types ────────────────────────────────────────────────

export type TenantId = string & { readonly __brand: 'TenantId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type LeadId = string & { readonly __brand: 'LeadId' };
export type ContactId = string & { readonly __brand: 'ContactId' };
export type AccountId = string & { readonly __brand: 'AccountId' };
export type DealId = string & { readonly __brand: 'DealId' };
export type ActivityId = string & { readonly __brand: 'ActivityId' };
export type ConversationId = string & { readonly __brand: 'ConversationId' };
export type WorkflowId = string & { readonly __brand: 'WorkflowId' };
export type CampaignId = string & { readonly __brand: 'CampaignId' };

// Brand constructors (runtime validation via Zod, these are compile-time only)
export const asTenantId = (s: string): TenantId => s as TenantId;
export const asUserId = (s: string): UserId => s as UserId;
export const asLeadId = (s: string): LeadId => s as LeadId;

// ─── API Response Envelope ──────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
  meta: ResponseMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  duration?: number;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  nextCursor?: string;
}

// ─── Auth & Tenant Context ───────────────────────────────────────────────────

export interface TenantContext {
  tenantId: TenantId;
  userId: UserId;
  role: UserRole;
  plan: SubscriptionPlan;
  permissions: Permission[];
  sessionId: string;
}

export type UserRole =
  | 'owner'
  | 'admin'
  | 'manager'
  | 'sales_rep'
  | 'marketing'
  | 'viewer';

export type SubscriptionPlan = 'standard' | 'professional' | 'enterprise';

export type Permission =
  | 'leads:read'
  | 'leads:write'
  | 'leads:delete'
  | 'contacts:read'
  | 'contacts:write'
  | 'contacts:delete'
  | 'deals:read'
  | 'deals:write'
  | 'deals:delete'
  | 'marketing:read'
  | 'marketing:connect'
  | 'ai_agent:read'
  | 'ai_agent:configure'
  | 'workflows:read'
  | 'workflows:write'
  | 'billing:read'
  | 'billing:write'
  | 'admin:read'
  | 'admin:write'
  | 'audit_log:read';

// ─── CRM Domain Types ────────────────────────────────────────────────────────

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'unqualified'
  | 'converted'
  | 'lost';

export type LeadSource =
  | 'whatsapp'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'web_chat'
  | 'email'
  | 'phone'
  | 'referral'
  | 'event'
  | 'manual'
  | 'import'
  | 'api';

export type DealStage =
  | 'prospecting'
  | 'qualification'
  | 'proposal'
  | 'negotiation'
  | 'closed_won'
  | 'closed_lost';

export type ActivityType =
  | 'call'
  | 'email'
  | 'meeting'
  | 'note'
  | 'task'
  | 'demo'
  | 'whatsapp'
  | 'message';

// ─── Marketing Intelligence Types ───────────────────────────────────────────

export type AdPlatform = 'meta' | 'tiktok' | 'google_ads';

export interface UnifiedMetricRow {
  tenantId: TenantId;
  date: string; // YYYY-MM-DD
  platform: AdPlatform;
  accountId: string;
  campaignId: string;
  campaignName: string;
  adsetId: string | null;
  adsetName: string | null;
  adId: string | null;
  adName: string | null;
  impressions: number;
  clicks: number;
  spendUsd: number;
  conversions: number;
  conversionValueUsd: number;
  ctr: number | null;
  cpcUsd: number | null;
  cpmUsd: number | null;
  cpaUsd: number | null;
  roas: number | null;
  reach: number | null;
  frequency: number | null;
  videoViews: number | null;
  extras: Record<string, unknown>;
  ingestedAt: string;
}

// ─── AI Agent Types ──────────────────────────────────────────────────────────

export type AgentChannel =
  | 'whatsapp'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'web_chat';

export type ConversationState =
  | 'GREETING'
  | 'QUALIFY'
  | 'EDUCATE'
  | 'HANDLE_OBJECTION'
  | 'BOOK_CALL'
  | 'HANDOFF'
  | 'CLOSE';

export interface TranscriptTurn {
  turnIndex: number;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
  sentimentScore: number | null;
  state: ConversationState;
  ragChunksUsed: string[]; // chunk IDs for audit
  confidenceScore: number | null;
}

// ─── Pub/Sub Event Schemas ───────────────────────────────────────────────────

export interface PubSubEnvelope<T> {
  eventType: string;
  eventId: string;
  timestamp: string;
  tenantId: TenantId;
  payload: T;
  version: '1.0';
}

export interface LeadCreatedEvent {
  leadId: LeadId;
  tenantId: TenantId;
  source: LeadSource;
  assignedUserId: UserId | null;
  fields: Record<string, unknown>;
}

export interface ConversationTurnEvent {
  conversationId: ConversationId;
  tenantId: TenantId;
  channel: AgentChannel;
  turn: TranscriptTurn;
  sessionUserId: string;
}

export interface ConversationEndedEvent {
  conversationId: ConversationId;
  tenantId: TenantId;
  channel: AgentChannel;
  resolution: 'booked' | 'handoff' | 'abandoned' | 'closed';
  leadId: LeadId | null;
  bookingRef: string | null;
  transcript: TranscriptTurn[];
  leadQualityScore: number | null;
  avgSentimentScore: number | null;
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export interface AuditEvent {
  tenantId: TenantId;
  userId: UserId;
  action: string; // e.g., 'lead.created', 'deal.deleted', 'connector.authorized'
  resourceType: string;
  resourceId: string;
  changes: AuditChange[];
  ipAddress: string;
  userAgent: string;
  timestamp: string;
}

export interface AuditChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// ─── Structured Logging ──────────────────────────────────────────────────────

export interface StructuredLog {
  severity: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  message: string;
  service: string;
  tenantId?: TenantId;
  userId?: UserId;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  [key: string]: unknown;
}
