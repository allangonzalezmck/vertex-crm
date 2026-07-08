/**
 * @file shared/src/schemas/index.ts
 * @description Zod runtime validation schemas for all API boundaries.
 * Every inbound request is validated here before touching business logic.
 * Exported schemas are the single source of truth for data shapes.
 */

import { z } from 'zod';

// ─── Primitives ──────────────────────────────────────────────────────────────

export const TenantIdSchema = z.string().uuid('Invalid tenant ID');
export const UserIdSchema = z.string().uuid('Invalid user ID');
export const LeadIdSchema = z.string().uuid('Invalid lead ID');
export const ContactIdSchema = z.string().uuid('Invalid contact ID');
export const DealIdSchema = z.string().uuid('Invalid deal ID');
export const ConversationIdSchema = z.string().uuid('Invalid conversation ID');

export const EmailSchema = z
  .string()
  .email('Invalid email address')
  .toLowerCase()
  .trim();

export const PhoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{6,14}$/, 'Invalid phone number (international format required)')
  .trim();

export const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format');

export const CursorSchema = z.string().base64().optional();

// ─── Pagination ──────────────────────────────────────────────────────────────

export const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: CursorSchema,
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;

// ─── CRM Schemas ─────────────────────────────────────────────────────────────

export const LeadStatusSchema = z.enum([
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'converted',
  'lost',
]);

export const LeadSourceSchema = z.enum([
  'whatsapp',
  'facebook',
  'instagram',
  'tiktok',
  'web_chat',
  'email',
  'phone',
  'referral',
  'event',
  'manual',
  'import',
  'api',
]);

export const CreateLeadSchema = z.object({
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  company: z.string().max(200).trim().optional(),
  source: LeadSourceSchema.default('manual'),
  status: LeadStatusSchema.default('new'),
  assignedUserId: UserIdSchema.optional(),
  pipelineId: z.string().uuid().optional(),
  customFields: z.record(z.unknown()).default({}),
  tags: z.array(z.string().max(50)).max(20).default([]),
  notes: z.string().max(5000).optional(),
}).refine(
  (data) => data.email || data.phone,
  { message: 'At least one of email or phone is required', path: ['email'] }
);

export type CreateLeadInput = z.infer<typeof CreateLeadSchema>;

export const UpdateLeadSchema = CreateLeadSchema.partial().extend({
  status: LeadStatusSchema.optional(),
});

export type UpdateLeadInput = z.infer<typeof UpdateLeadSchema>;

export const DealStageSchema = z.enum([
  'prospecting',
  'qualification',
  'proposal',
  'negotiation',
  'closed_won',
  'closed_lost',
]);

export const CreateDealSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  value: z.number().nonnegative().max(1_000_000_000),
  currency: z.string().length(3).default('USD'),
  stage: DealStageSchema.default('prospecting'),
  pipelineId: z.string().uuid(),
  contactId: ContactIdSchema.optional(),
  accountId: z.string().uuid().optional(),
  expectedCloseDate: DateSchema.optional(),
  assignedUserId: UserIdSchema.optional(),
  customFields: z.record(z.unknown()).default({}),
  tags: z.array(z.string().max(50)).max(20).default([]),
});

export type CreateDealInput = z.infer<typeof CreateDealSchema>;

export const CreateContactSchema = z.object({
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  title: z.string().max(200).trim().optional(),
  accountId: z.string().uuid().optional(),
  linkedInUrl: z.string().url().optional(),
  customFields: z.record(z.unknown()).default({}),
  tags: z.array(z.string().max(50)).max(20).default([]),
});

export type CreateContactInput = z.infer<typeof CreateContactSchema>;

export const ActivityTypeSchema = z.enum([
  'call',
  'email',
  'meeting',
  'note',
  'task',
  'demo',
  'whatsapp',
  'message',
]);

export const CreateActivitySchema = z.object({
  type: ActivityTypeSchema,
  subject: z.string().min(1).max(500).trim(),
  description: z.string().max(10000).optional(),
  relatedToType: z.enum(['lead', 'contact', 'deal', 'account']),
  relatedToId: z.string().uuid(),
  scheduledAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMinutes: z.number().int().positive().max(480).optional(),
  assignedUserId: UserIdSchema.optional(),
  outcome: z.string().max(2000).optional(),
});

export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;

// ─── Marketing Intelligence Schemas ─────────────────────────────────────────

export const AdPlatformSchema = z.enum(['meta', 'tiktok', 'google_ads']);

export const ConnectorAuthSchema = z.object({
  platform: AdPlatformSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  accountIds: z.array(z.string().min(1)).min(1).max(50),
  metadata: z.record(z.unknown()).default({}),
});

export type ConnectorAuthInput = z.infer<typeof ConnectorAuthSchema>;

export const MetricQuerySchema = z.object({
  platforms: z.array(AdPlatformSchema).min(1).default(['meta', 'tiktok', 'google_ads']),
  dateFrom: DateSchema,
  dateTo: DateSchema,
  campaignIds: z.array(z.string()).optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  metrics: z.array(z.string()).optional(), // empty = all metrics
  groupBy: z.array(z.enum(['platform', 'campaign', 'adset', 'ad'])).default(['campaign']),
}).refine(
  (data) => new Date(data.dateFrom) <= new Date(data.dateTo),
  { message: 'dateFrom must be before or equal to dateTo' }
);

export type MetricQueryInput = z.infer<typeof MetricQuerySchema>;

// ─── AI Agent Schemas ────────────────────────────────────────────────────────

export const AgentChannelSchema = z.enum([
  'whatsapp',
  'facebook',
  'instagram',
  'tiktok',
  'web_chat',
]);

export const InboundMessageSchema = z.object({
  channel: AgentChannelSchema,
  channelUserId: z.string().min(1).max(500), // platform-specific user ID
  tenantId: TenantIdSchema,
  messageId: z.string().min(1).max(500),
  content: z.string().min(1).max(4096),
  contentType: z.enum(['text', 'image', 'audio', 'document', 'sticker']).default('text'),
  mediaUrl: z.string().url().optional(),
  timestamp: z.string().datetime(),
  replyToMessageId: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const KnowledgeBaseDocumentSchema = z.object({
  title: z.string().min(1).max(500).trim(),
  contentType: z.enum(['pdf', 'docx', 'url', 'text', 'csv', 'youtube']),
  sourceUrl: z.string().url().optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
});

export type KnowledgeBaseDocumentInput = z.infer<typeof KnowledgeBaseDocumentSchema>;

// ─── Workflow Schemas ────────────────────────────────────────────────────────

export const WorkflowTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    event: z.enum([
      'lead.created',
      'lead.status.changed',
      'deal.stage.changed',
      'deal.created',
      'conversation.ended',
      'contact.created',
    ]),
    filters: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().regex(/^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/),
    timezone: z.string().default('UTC'),
  }),
  z.object({
    type: z.literal('manual'),
    allowedRoles: z.array(z.string()).default(['admin', 'manager']),
  }),
]);

export const WorkflowActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send_email'),
    templateId: z.string().uuid(),
    toField: z.string(), // field path e.g., 'lead.email'
    delay: z.number().int().nonnegative().default(0), // seconds
  }),
  z.object({
    type: z.literal('update_field'),
    resource: z.enum(['lead', 'deal', 'contact']),
    field: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('create_activity'),
    activityType: ActivityTypeSchema,
    subject: z.string().min(1).max(500),
    assignToField: z.string().optional(),
  }),
  z.object({
    type: z.literal('notify_slack'),
    channelId: z.string().min(1),
    messageTemplate: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal('http_webhook'),
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('POST'),
    headers: z.record(z.string()).default({}),
    bodyTemplate: z.string().optional(),
  }),
]);

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean().default(false),
  trigger: WorkflowTriggerSchema,
  conditions: z.array(z.object({
    field: z.string().min(1),
    operator: z.enum(['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty']),
    value: z.unknown(),
  })).max(10).default([]),
  actions: z.array(WorkflowActionSchema).min(1).max(10),
});

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>;

// ─── Auth/Tenant Schemas ─────────────────────────────────────────────────────

export const TenantOnboardingSchema = z.object({
  organizationName: z.string().min(2).max(200).trim(),
  subdomain: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Subdomain must be lowercase alphanumeric with hyphens')
    .trim(),
  adminEmail: EmailSchema,
  adminFirstName: z.string().min(1).max(100).trim(),
  adminLastName: z.string().min(1).max(100).trim(),
  industry: z.string().max(100).optional(),
  companySize: z.enum(['1-10', '11-50', '51-200', '201-1000', '1000+']).optional(),
  plan: z.enum(['standard', 'professional']).default('standard'),
  timezone: z.string().default('UTC'),
  currency: z.string().length(3).default('USD'),
});

export type TenantOnboardingInput = z.infer<typeof TenantOnboardingSchema>;

// ─── Billing Schemas ─────────────────────────────────────────────────────────

export const StripeWebhookSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({
    object: z.record(z.unknown()),
  }),
  livemode: z.boolean(),
  created: z.number(),
});

export type StripeWebhookPayload = z.infer<typeof StripeWebhookSchema>;

// ─── Response Helpers ─────────────────────────────────────────────────────────

export function successResponse<T>(
  data: T,
  requestId: string,
  pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
  },
  duration?: number
) {
  const totalPages = pagination
    ? Math.ceil(pagination.totalItems / pagination.pageSize)
    : undefined;

  return {
    data,
    error: null,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
      duration,
      pagination: pagination
        ? {
            page: pagination.page,
            pageSize: pagination.pageSize,
            totalItems: pagination.totalItems,
            totalPages: totalPages!,
            hasNextPage: pagination.page < totalPages!,
            hasPrevPage: pagination.page > 1,
          }
        : undefined,
    },
  };
}

export function errorResponse(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>
) {
  return {
    data: null,
    error: { code, message, details, requestId },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  };
}
