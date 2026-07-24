/**
 * @file services/crm-service/src/services/lead.service.ts
 * @description Lead business logic. All DB access goes through this layer.
 * Route handlers call methods here — never direct DB in routes.
 * Publishes domain events to Pub/Sub for async consumers.
 */

import { randomUUID } from 'crypto';
import {
  getTenantClient,
  withTransaction,
} from '@vertex/shared/utils/database';
type TenantClient = Awaited<ReturnType<typeof getTenantClient>>;

import { publishEvent, TOPICS } from '@vertex/shared/utils/pubsub';
import {
  type TenantId,
  type UserId,
  type LeadId,
  type LeadCreatedEvent,
  asTenantId,
  asLeadId,
} from '@vertex/shared/types';
import type {
  CreateLeadInput,
  UpdateLeadInput,
} from '@vertex/shared/schemas';
import { createLogger } from '@vertex/shared/utils/logger';

const logger = createLogger('crm-service:lead-service');

// ─── Domain Types ────────────────────────────────────────────────────────────

export interface Lead {
  id: LeadId;
  tenantId: TenantId;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  status: string;
  pipelineId: string | null;
  assignedUserId: UserId | null;
  customFields: Record<string, unknown>;
  tags: string[];
  notes: string | null;
  leadQualityScore: number | null;
  sentimentScore: number | null;
  conversationId: string | null;
  bookingRef: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LeadListOptions {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  filters: {
    status?: string;
    source?: string;
    assignedUserId?: string;
    search?: string;
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface TimelineEntry {
  id: string;
  type: 'activity' | 'email' | 'conversation_turn' | 'note' | 'status_change' | 'field_change';
  timestamp: string;
  summary: string;
  detail: Record<string, unknown>;
  userId: UserId | null;
  userName: string | null;
}

// ─── Lead Service ────────────────────────────────────────────────────────────

export class LeadService {
  /**
   * List leads for a tenant with filtering, sorting, and pagination.
   * Uses PostgreSQL RLS — tenant_id filter is enforced at DB level.
   */
  async listLeads(
    tenantId: TenantId,
    options: LeadListOptions
  ): Promise<{ leads: Lead[]; total: number }> {
    const client = await getTenantClient(tenantId, logger);

    try {
      // Build dynamic WHERE clause using parameterized values only
      const conditions: string[] = ['deleted_at IS NULL'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (options.filters.status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(options.filters.status);
      }

      if (options.filters.source) {
        conditions.push(`source = $${paramIndex++}`);
        params.push(options.filters.source);
      }

      if (options.filters.assignedUserId) {
        conditions.push(`assigned_user_id = $${paramIndex++}`);
        params.push(options.filters.assignedUserId);
      }

      if (options.filters.search) {
        // Full-text search across name, email, company using GIN index
        conditions.push(`search_vector @@ plainto_tsquery('english', $${paramIndex++})`);
        params.push(options.filters.search);
      }

      if (options.filters.tags && options.filters.tags.length > 0) {
        conditions.push(`tags && $${paramIndex++}::text[]`);
        params.push(options.filters.tags);
      }

      if (options.filters.dateFrom) {
        conditions.push(`created_at >= $${paramIndex++}`);
        params.push(options.filters.dateFrom);
      }

      if (options.filters.dateTo) {
        conditions.push(`created_at <= $${paramIndex++}`);
        params.push(options.filters.dateTo + 'T23:59:59Z');
      }

      const whereClause = conditions.join(' AND ');

      // Allowlist for sort column to prevent SQL injection
      const allowedSortColumns: Record<string, string> = {
        created_at: 'created_at',
        updated_at: 'updated_at',
        first_name: 'first_name',
        last_name: 'last_name',
        company: 'company',
        status: 'status',
        lead_quality_score: 'lead_quality_score',
      };

      const sortColumn = allowedSortColumns[options.sortBy] ?? 'created_at';
      const sortDirection = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
      const offset = (options.page - 1) * options.pageSize;

      // Count query (uses same WHERE clause)
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM leads WHERE ${whereClause}`,
        params
      );

      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      // Data query with pagination
      params.push(options.pageSize, offset);
      const dataResult = await client.query<LeadRow>(
        `SELECT
          id, tenant_id, first_name, last_name,
          CONCAT(first_name, ' ', last_name) AS full_name,
          email, phone, company, source, status,
          pipeline_id, assigned_user_id, custom_fields, tags, notes,
          lead_quality_score, sentiment_score, conversation_id, booking_ref,
          created_at, updated_at, deleted_at
        FROM leads
        WHERE ${whereClause}
        ORDER BY ${sortColumn} ${sortDirection}
        LIMIT $${paramIndex++}
        OFFSET $${paramIndex}`,
        params
      );

      return {
        leads: dataResult.rows.map(mapRowToLead),
        total,
      };
    } finally {
      client.release();
    }
  }

  async getLeadById(tenantId: TenantId, leadId: string): Promise<Lead | null> {
    const client = await getTenantClient(tenantId, logger);

    try {
      const result = await client.query<LeadRow>(
        `SELECT
          l.*,
          CONCAT(l.first_name, ' ', l.last_name) AS full_name,
          json_agg(DISTINCT jsonb_build_object(
            'id', a.id,
            'type', a.type,
            'subject', a.subject,
            'completed_at', a.completed_at,
            'created_at', a.created_at
          )) FILTER (WHERE a.id IS NOT NULL) AS recent_activities
        FROM leads l
        LEFT JOIN activities a ON a.related_to_id = l.id
          AND a.related_to_type = 'lead'
          AND a.created_at > NOW() - INTERVAL '30 days'
        WHERE l.id = $1 AND l.deleted_at IS NULL
        GROUP BY l.id`,
        [leadId]
      );

      if (result.rows.length === 0) return null;
      return mapRowToLead(result.rows[0]!);
    } finally {
      client.release();
    }
  }

  async createLead(
    tenantId: TenantId,
    userId: UserId,
    input: CreateLeadInput
  ): Promise<Lead> {
    const leadId = randomUUID() as LeadId;

    const lead = await withTransaction(tenantId, async (client) => {
      const result = await client.query<LeadRow>(
        `INSERT INTO leads (
          id, tenant_id, first_name, last_name, email, phone, company,
          source, status, pipeline_id, assigned_user_id, custom_fields,
          tags, notes, created_by_user_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
          $13::text[], $14, $15
        )
        RETURNING *`,
        [
          leadId,
          tenantId,
          input.firstName,
          input.lastName,
          input.email ?? null,
          input.phone ?? null,
          input.company ?? null,
          input.source,
          input.status,
          input.pipelineId ?? null,
          input.assignedUserId ?? userId,
          JSON.stringify(input.customFields),
          input.tags,
          input.notes ?? null,
          userId,
        ]
      );

      // Write audit event
      await this.writeAuditEvent(client, tenantId, userId, 'lead.created', 'lead', leadId, [], {});

      return mapRowToLead(result.rows[0]!);
    }, logger);

    // Publish domain event (async — don't block response)
    void publishEvent<LeadCreatedEvent>(
      TOPICS.LEAD_CREATED,
      'lead.created',
      tenantId,
      {
        leadId: lead.id,
        tenantId,
        source: input.source,
        assignedUserId: lead.assignedUserId,
        fields: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          company: input.company,
        },
      },
      logger
    );

    logger.info('Lead created', { tenantId, leadId, source: input.source });
    return lead;
  }

  async updateLead(
    tenantId: TenantId,
    userId: UserId,
    leadId: string,
    input: UpdateLeadInput
  ): Promise<Lead | null> {
    return withTransaction(tenantId, async (client) => {
      // Fetch current values for audit diff
      const currentResult = await client.query<LeadRow>(
        'SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL',
        [leadId]
      );

      if (currentResult.rows.length === 0) return null;
      const current = currentResult.rows[0]!;

      // Build SET clause dynamically — only update provided fields
      const setClauses: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [];
      let paramIndex = 1;

      const fieldMap: Record<string, string> = {
        firstName: 'first_name',
        lastName: 'last_name',
        email: 'email',
        phone: 'phone',
        company: 'company',
        source: 'source',
        status: 'status',
        pipelineId: 'pipeline_id',
        assignedUserId: 'assigned_user_id',
        notes: 'notes',
      };

      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];

      for (const [inputField, dbField] of Object.entries(fieldMap)) {
        const value = input[inputField as keyof UpdateLeadInput];
        if (value !== undefined) {
          setClauses.push(`${dbField} = $${paramIndex++}`);
          params.push(value);

          const oldValue = current[dbField as keyof LeadRow];
          if (oldValue !== value) {
            changes.push({ field: inputField, oldValue, newValue: value });
          }
        }
      }

      if (input.customFields !== undefined) {
        // Merge custom fields (JSONB merge, not replace)
        setClauses.push(`custom_fields = custom_fields || $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(input.customFields));
      }

      if (input.tags !== undefined) {
        setClauses.push(`tags = $${paramIndex++}::text[]`);
        params.push(input.tags);
      }

      params.push(leadId);
      const result = await client.query<LeadRow>(
        `UPDATE leads
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex} AND deleted_at IS NULL
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) return null;

      await this.writeAuditEvent(client, tenantId, userId, 'lead.updated', 'lead', leadId as LeadId, changes, {});

      return mapRowToLead(result.rows[0]!);
    }, logger);
  }

  async deleteLead(
    tenantId: TenantId,
    userId: UserId,
    leadId: string
  ): Promise<boolean> {
    return withTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE leads SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL`,
        [leadId]
      );

      if ((result.rowCount ?? 0) === 0) return false;

      await this.writeAuditEvent(client, tenantId, userId, 'lead.deleted', 'lead', leadId as LeadId, [], {});

      return true;
    }, logger);
  }

  /**
   * Convert a lead to Contact + Account + Deal.
   * Atomic transaction: all records created or none.
   */
  async convertLead(
    tenantId: TenantId,
    userId: UserId,
    leadId: string,
    options: { createDeal: boolean; dealName?: string; dealValue?: number; pipelineId?: string }
  ): Promise<{ contactId: string; accountId?: string; dealId?: string } | null> {
    return withTransaction(tenantId, async (client) => {
      // Fetch lead
      const leadResult = await client.query<LeadRow>(
        'SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL AND status != $2',
        [leadId, 'converted']
      );

      if (leadResult.rows.length === 0) return null;
      const lead = leadResult.rows[0]!;

      // Create Contact
      const contactId = randomUUID();
      await client.query(
        `INSERT INTO contacts (id, tenant_id, first_name, last_name, email, phone, custom_fields, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [contactId, tenantId, lead.first_name, lead.last_name, lead.email, lead.phone, '{}', userId]
      );

      let accountId: string | undefined;
      if (lead.company) {
        accountId = randomUUID();
        await client.query(
          `INSERT INTO accounts (id, tenant_id, name, created_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [accountId, tenantId, lead.company, userId]
        );

        // Link contact to account
        await client.query(
          'UPDATE contacts SET account_id = $1 WHERE id = $2',
          [accountId, contactId]
        );
      }

      let dealId: string | undefined;
      if (options.createDeal) {
        dealId = randomUUID();
        const defaultPipelineResult = await client.query<{ id: string }>(
          'SELECT id FROM pipelines WHERE tenant_id = $1 AND is_default = true LIMIT 1',
          [tenantId]
        );

        const pipelineId = options.pipelineId ?? defaultPipelineResult.rows[0]?.id;

        await client.query(
          `INSERT INTO deals (id, tenant_id, name, value, contact_id, account_id, pipeline_id, stage, assigned_user_id, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            dealId, tenantId,
            options.dealName ?? `${lead.first_name} ${lead.last_name} - Deal`,
            options.dealValue ?? 0,
            contactId,
            accountId ?? null,
            pipelineId ?? null,
            'prospecting',
            lead.assigned_user_id ?? userId,
            userId,
          ]
        );
      }

      // Mark lead as converted
      await client.query(
        `UPDATE leads SET status = 'converted', converted_at = NOW(),
         converted_contact_id = $1, converted_deal_id = $2
         WHERE id = $3`,
        [contactId, dealId ?? null, leadId]
      );

      await this.writeAuditEvent(client, tenantId, userId, 'lead.converted', 'lead', leadId as LeadId, [
        { field: 'status', oldValue: lead.status, newValue: 'converted' },
      ], { contactId, accountId, dealId });

      return { contactId, accountId, dealId };
    }, logger);
  }

  async getLeadTimeline(
    tenantId: TenantId,
    leadId: string,
    options: { limit: number; cursor?: string }
  ): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
    const client = await getTenantClient(tenantId, logger);

    try {
      const cursorCondition = options.cursor
        ? `AND created_at < '${Buffer.from(options.cursor, 'base64').toString()}'`
        : '';

      // Union of activities, email logs, conversation turns — unified timeline
      const result = await client.query<TimelineEntry & { created_at: string }>(
        `(
          SELECT
            a.id, 'activity' as type, a.created_at as timestamp,
            a.subject as summary,
            jsonb_build_object('type', a.type, 'description', a.description, 'outcome', a.outcome) as detail,
            a.assigned_user_id as user_id,
            CONCAT(u.first_name, ' ', u.last_name) as user_name
          FROM activities a
          LEFT JOIN users u ON u.id = a.assigned_user_id
          WHERE a.related_to_id = $1 AND a.related_to_type = 'lead'
            ${cursorCondition}
        )
        UNION ALL
        (
          SELECT
            ct.id, 'conversation_turn' as type, ct.created_at as timestamp,
            LEFT(ct.content, 100) as summary,
            jsonb_build_object('role', ct.role, 'state', ct.state, 'sentiment', ct.sentiment_score) as detail,
            NULL as user_id, NULL as user_name
          FROM conversation_turns ct
          JOIN conversations c ON c.id = ct.conversation_id
          WHERE c.crm_lead_id = $1 ${cursorCondition}
        )
        ORDER BY timestamp DESC
        LIMIT $2`,
        [leadId, options.limit + 1] // fetch one extra to detect next page
      );

      const entries = result.rows.slice(0, options.limit);
      const hasMore = result.rows.length > options.limit;
      const nextCursor = hasMore
        ? Buffer.from(entries[entries.length - 1]!.timestamp).toString('base64')
        : null;

      return { entries, nextCursor };
    } finally {
      client.release();
    }
  }

  async bulkImportLeads(
    tenantId: TenantId,
    userId: UserId,
    options: { rows: CreateLeadInput[]; deduplicateBy: string; updateExisting: boolean }
  ): Promise<{ id: string }> {
    // Enqueue as Pub/Sub message for async processing via Cloud Run Job
    const jobId = randomUUID();
    await publishEvent(
      'bulk-import.trigger',
      'bulk_import.leads.requested',
      tenantId,
      {
        jobId,
        userId,
        rows: options.rows,
        deduplicateBy: options.deduplicateBy,
        updateExisting: options.updateExisting,
      },
      logger
    );
    return { id: jobId };
  }

  private async writeAuditEvent(
    client: TenantClient,
    tenantId: TenantId,
    userId: UserId,
    action: string,
    resourceType: string,
    resourceId: LeadId | string,
    changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (id, tenant_id, user_id, action, resource_type, resource_id, changes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [
        randomUUID(),
        tenantId,
        userId,
        action,
        resourceType,
        resourceId,
        JSON.stringify(changes),
        JSON.stringify(metadata),
      ]
    );
  }
}

// ─── Row Mapping ──────────────────────────────────────────────────────────────

interface LeadRow {
  id: string;
  tenant_id: string;
  first_name: string;
  last_name: string;
  full_name?: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  status: string;
  pipeline_id: string | null;
  assigned_user_id: string | null;
  custom_fields: Record<string, unknown>;
  tags: string[];
  notes: string | null;
  lead_quality_score: number | null;
  sentiment_score: number | null;
  conversation_id: string | null;
  booking_ref: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [key: string]: unknown;
}

function mapRowToLead(row: LeadRow): Lead {
  return {
    id: asLeadId(row.id),
    tenantId: asTenantId(row.tenant_id),
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name ?? `${row.first_name} ${row.last_name}`,
    email: row.email,
    phone: row.phone,
    company: row.company,
    source: row.source,
    status: row.status,
    pipelineId: row.pipeline_id,
    assignedUserId: row.assigned_user_id as UserId | null,
    customFields: row.custom_fields ?? {},
    tags: row.tags ?? [],
    notes: row.notes,
    leadQualityScore: row.lead_quality_score,
    sentimentScore: row.sentiment_score,
    conversationId: row.conversation_id,
    bookingRef: row.booking_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
