/**
 * @file services/crm-service/src/routes/leads.ts
 * @description Lead management API routes.
 * All handlers delegate to LeadService — no DB access in route layer.
 * Tenant context is injected by the tenantContextPlugin.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CreateLeadSchema,
  UpdateLeadSchema,
  PaginationSchema,
  successResponse,
  errorResponse,
} from '../../../../shared/src/schemas/index.js';
import { LeadService } from '../services/lead.service.js';
import type { TenantContext } from '../../../../shared/src/types/index.js';
import { z } from 'zod';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext: TenantContext;
  }
}

// ─── Query Parameter Schemas ─────────────────────────────────────────────────

const ListLeadsQuerySchema = PaginationSchema.extend({
  status: z.enum(['new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost']).optional(),
  source: z.enum(['whatsapp', 'facebook', 'instagram', 'tiktok', 'web_chat', 'email', 'phone', 'referral', 'event', 'manual', 'import', 'api']).optional(),
  assignedUserId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  tags: z.string().optional(), // comma-separated
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const LeadIdParamSchema = z.object({
  id: z.string().uuid('Invalid lead ID'),
});

// ─── Route Registration ──────────────────────────────────────────────────────

export async function leadsRouter(app: FastifyInstance): Promise<void> {
  const leadService = new LeadService();

  /**
   * GET /api/v1/leads/dashboard
   * Aggregated Lead-to-Customer Journey data for the main dashboard:
   * KPI strip, 12-month trend, conversion funnel, top leads (30d), follow-ups.
   * Fastify matches static '/dashboard' before '/:id', so no UUID clash.
   */
  app.get('/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    const { db } = request as any; // RLS-scoped client from tenantContextPlugin

    const [kpiRes, trendRes, topRes, followRes] = await Promise.all([
      // KPI counts, current 30d vs previous 30d
      db.query(`
        WITH cur AS (
          SELECT status, COUNT(*)::int AS n FROM leads
          WHERE created_at >= now() - interval '30 days' AND deleted_at IS NULL
          GROUP BY status
        ), prev AS (
          SELECT status, COUNT(*)::int AS n FROM leads
          WHERE created_at >= now() - interval '60 days'
            AND created_at <  now() - interval '30 days' AND deleted_at IS NULL
          GROUP BY status
        )
        SELECT COALESCE(c.status, p.status) AS status,
               COALESCE(c.n, 0) AS current, COALESCE(p.n, 0) AS previous
        FROM cur c FULL OUTER JOIN prev p USING (status)
      `),
      // 12-month trend by status bucket
      db.query(`
        SELECT to_char(date_trunc('month', created_at), 'Mon') AS month,
               date_trunc('month', created_at) AS m,
               COUNT(*) FILTER (WHERE status = 'new')::int                          AS new_leads,
               COUNT(*) FILTER (WHERE status IN ('contacted','qualified'))::int     AS in_progress,
               COUNT(*) FILTER (WHERE status = 'converted')::int                    AS won,
               COUNT(*) FILTER (WHERE status = 'unqualified')::int                  AS lost
        FROM leads
        WHERE created_at >= date_trunc('month', now()) - interval '11 months'
          AND deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY 2
      `),
      // Top 8 leads of last 30 days by quality score
      db.query(`
        SELECT l.id, COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'') AS name,
               l.source, l.status, COALESCE(l.lead_quality_score, l.lead_score, 0)::int AS score,
               to_char(l.updated_at, 'Mon DD, HH24:MI') AS last_contact,
               (SELECT to_char(MIN(a.scheduled_at), 'Mon DD, HH24:MI') FROM activities a
                 WHERE a.lead_id = l.id AND a.completed_at IS NULL AND a.scheduled_at >= now()) AS next_follow_up
        FROM leads l
        WHERE l.created_at >= now() - interval '30 days' AND l.deleted_at IS NULL
        ORDER BY COALESCE(l.lead_quality_score, l.lead_score) DESC NULLS LAST
        LIMIT 8
      `),
      // Today's follow-up queue (due in next 24h, uncompleted)
      db.query(`
        SELECT a.id, a.lead_id,
               COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'') AS name,
               l.status AS stage, a.type
        FROM activities a
        JOIN leads l ON l.id = a.lead_id
        WHERE a.completed_at IS NULL
          AND a.scheduled_at BETWEEN now() AND now() + interval '24 hours'
        ORDER BY a.scheduled_at ASC LIMIT 6
      `),
    ]);

    const statusLabel: Record<string, string> = {
      new: 'Total New Leads', contacted: 'In Progress', qualified: 'Qualified',
      converted: 'Won (Customers)', unqualified: 'Lost',
    };
    const pctChange = (cur: number, prev: number) =>
      prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 1000) / 10;

    const byStatus: Record<string, { current: number; previous: number }> = {};
    for (const r of kpiRes.rows) byStatus[r.status] = { current: r.current, previous: r.previous };

    const totalCur = Object.values(byStatus).reduce((s, v) => s + v.current, 0);
    const totalPrev = Object.values(byStatus).reduce((s, v) => s + v.previous, 0);
    const wonCur = byStatus['converted']?.current ?? 0;
    const wonPrev = byStatus['converted']?.previous ?? 0;
    const convCur = totalCur ? Math.round((wonCur / totalCur) * 1000) / 10 : 0;
    const convPrev = totalPrev ? Math.round((wonPrev / totalPrev) * 1000) / 10 : 0;

    const kpis = [
      { key: 'total_new', label: 'Total New Leads', value: totalCur, change: pctChange(totalCur, totalPrev) },
      ...(['contacted', 'qualified', 'converted', 'unqualified'] as const).map((s) => ({
        key: s === 'converted' ? 'won' : s === 'unqualified' ? 'lost' : s === 'contacted' ? 'high' : 'nurtured',
        label: statusLabel[s] ?? s,
        value: byStatus[s]?.current ?? 0,
        change: pctChange(byStatus[s]?.current ?? 0, byStatus[s]?.previous ?? 0),
      })),
      { key: 'conversion', label: 'Lead→Sale Conversion', value: convCur, change: Math.round((convCur - convPrev) * 10) / 10, isPercent: true, isPp: true },
    ];

    const funnelTotal = totalCur || 1;
    const engaged = (byStatus['contacted']?.current ?? 0) + (byStatus['qualified']?.current ?? 0);
    const funnel = [
      { label: 'New Leads', value: totalCur, pct: 100 },
      { label: 'Engaged In Progress', value: engaged, pct: Math.round((engaged / funnelTotal) * 1000) / 10 },
      { label: 'Qualified', value: byStatus['qualified']?.current ?? 0, pct: Math.round(((byStatus['qualified']?.current ?? 0) / funnelTotal) * 1000) / 10 },
      { label: 'Won (Customers)', value: wonCur, pct: convCur },
    ];

    const stageDisplay: Record<string, string> = {
      new: 'New', contacted: 'In Progress – High', qualified: 'Nurtured',
      converted: 'Won', unqualified: 'Lost',
    };

    return reply.send(successResponse({
      kpis,
      trend: trendRes.rows.map((r: any) => ({
        month: r.month, newLeads: r.new_leads, inProgress: r.in_progress,
        nurtured: 0, won: r.won, lost: r.lost,
      })),
      funnel,
      topLeads: topRes.rows.map((r: any) => ({
        id: r.id, name: r.name.trim() || 'Unknown', source: r.source ?? '—',
        stage: stageDisplay[r.status] ?? r.status, score: r.score,
        lastContact: r.last_contact, nextFollowUp: r.next_follow_up,
      })),
      followUps: followRes.rows.map((r: any) => ({
        id: r.id, leadId: r.lead_id, name: r.name.trim() || 'Unknown',
        stage: stageDisplay[r.stage] ?? r.stage,
        action: r.type === 'call' ? 'call' : 'message',
      })),
      comparison: [
        { metric: 'Total New Leads', current: String(totalCur), previous: String(totalPrev), change: `${pctChange(totalCur, totalPrev) >= 0 ? '+' : ''}${pctChange(totalCur, totalPrev)}%`, positive: totalCur >= totalPrev },
        { metric: 'Leads Won', current: String(wonCur), previous: String(wonPrev), change: `${pctChange(wonCur, wonPrev) >= 0 ? '+' : ''}${pctChange(wonCur, wonPrev)}%`, positive: wonCur >= wonPrev },
        { metric: 'Conversion Rate', current: `${convCur}%`, previous: `${convPrev}%`, change: `${convCur - convPrev >= 0 ? '+' : ''}${Math.round((convCur - convPrev) * 10) / 10} pp`, positive: convCur >= convPrev },
      ],
    }, request.id));
  });

  /**
   * GET /api/v1/leads
   * List leads for the authenticated tenant with filtering and pagination.
   */
  app.get('/', async (
    request: FastifyRequest<{ Querystring: z.infer<typeof ListLeadsQuerySchema> }>,
    reply: FastifyReply
  ) => {
    const parseResult = ListLeadsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid query parameters', request.id, {
          issues: parseResult.error.flatten(),
        })
      );
    }

    const { page, pageSize, sortBy, sortOrder, status, source, assignedUserId, search, tags, dateFrom, dateTo } = parseResult.data;
    const { tenantId } = request.tenantContext;

    const result = await leadService.listLeads(tenantId, {
      page,
      pageSize,
      sortBy: sortBy ?? 'created_at',
      sortOrder,
      filters: {
        status,
        source,
        assignedUserId,
        search,
        tags: tags ? tags.split(',').map(t => t.trim()) : undefined,
        dateFrom,
        dateTo,
      },
    });

    return reply.send(
      successResponse(result.leads, request.id, {
        page,
        pageSize,
        totalItems: result.total,
      })
    );
  });

  /**
   * GET /api/v1/leads/:id
   * Fetch a single lead with full detail (activities, deals, notes).
   */
  app.get('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const parseResult = LeadIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid lead ID', request.id)
      );
    }

    const { tenantId } = request.tenantContext;
    const lead = await leadService.getLeadById(tenantId, parseResult.data.id);

    if (!lead) {
      return reply.status(404).send(
        errorResponse('NOT_FOUND', 'Lead not found', request.id)
      );
    }

    return reply.send(successResponse(lead, request.id));
  });

  /**
   * POST /api/v1/leads
   * Create a new lead. Publishes lead.created event for workflows.
   */
  app.post('/', async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const parseResult = CreateLeadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid lead data', request.id, {
          issues: parseResult.error.flatten(),
        })
      );
    }

    const { tenantId, userId } = request.tenantContext;
    const lead = await leadService.createLead(tenantId, userId, parseResult.data);

    return reply.status(201).send(successResponse(lead, request.id));
  });

  /**
   * PATCH /api/v1/leads/:id
   * Partial update. Only provided fields are changed.
   */
  app.patch('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const paramResult = LeadIdParamSchema.safeParse(request.params);
    const bodyResult = UpdateLeadSchema.safeParse(request.body);

    if (!paramResult.success || !bodyResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid request', request.id, {
          paramIssues: paramResult.success ? undefined : paramResult.error.flatten(),
          bodyIssues: bodyResult.success ? undefined : bodyResult.error.flatten(),
        })
      );
    }

    const { tenantId, userId } = request.tenantContext;
    const lead = await leadService.updateLead(
      tenantId,
      userId,
      paramResult.data.id,
      bodyResult.data
    );

    if (!lead) {
      return reply.status(404).send(
        errorResponse('NOT_FOUND', 'Lead not found', request.id)
      );
    }

    return reply.send(successResponse(lead, request.id));
  });

  /**
   * DELETE /api/v1/leads/:id
   * Soft delete (sets deleted_at, hidden from queries, retained for audit).
   */
  app.delete('/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const parseResult = LeadIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid lead ID', request.id)
      );
    }

    const { tenantId, userId } = request.tenantContext;
    const deleted = await leadService.deleteLead(tenantId, userId, parseResult.data.id);

    if (!deleted) {
      return reply.status(404).send(
        errorResponse('NOT_FOUND', 'Lead not found', request.id)
      );
    }

    return reply.status(204).send();
  });

  /**
   * POST /api/v1/leads/:id/convert
   * Convert a lead to Contact + Account + Deal.
   * Atomic transaction: all three or none.
   */
  app.post('/:id/convert', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const parseResult = LeadIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid lead ID', request.id)
      );
    }

    const ConvertLeadBodySchema = z.object({
      createDeal: z.boolean().default(true),
      dealName: z.string().max(200).optional(),
      dealValue: z.number().nonnegative().optional(),
      pipelineId: z.string().uuid().optional(),
    });

    const bodyResult = ConvertLeadBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid conversion options', request.id)
      );
    }

    const { tenantId, userId } = request.tenantContext;
    const result = await leadService.convertLead(
      tenantId,
      userId,
      parseResult.data.id,
      bodyResult.data
    );

    if (!result) {
      return reply.status(404).send(
        errorResponse('NOT_FOUND', 'Lead not found', request.id)
      );
    }

    return reply.status(201).send(successResponse(result, request.id));
  });

  /**
   * GET /api/v1/leads/:id/timeline
   * Full activity timeline for a lead (activities, emails, conversations).
   */
  app.get('/:id/timeline', async (
    request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>,
    reply: FastifyReply
  ) => {
    const parseResult = LeadIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid lead ID', request.id)
      );
    }

    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const { tenantId } = request.tenantContext;

    const timeline = await leadService.getLeadTimeline(
      tenantId,
      parseResult.data.id,
      { limit, cursor: request.query.cursor }
    );

    return reply.send(successResponse(timeline, request.id));
  });

  /**
   * POST /api/v1/leads/bulk-import
   * Async bulk import via CSV data. Returns job ID to poll status.
   * Rate limited: max 5 imports per tenant per hour.
   */
  app.post('/bulk-import', async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const BulkImportSchema = z.object({
      rows: z.array(CreateLeadSchema).min(1).max(10000),
      deduplicateBy: z.enum(['email', 'phone', 'both']).default('email'),
      updateExisting: z.boolean().default(false),
    });

    const parseResult = BulkImportSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send(
        errorResponse('VALIDATION_ERROR', 'Invalid import data', request.id, {
          issues: parseResult.error.flatten(),
        })
      );
    }

    const { tenantId, userId } = request.tenantContext;
    const job = await leadService.bulkImportLeads(
      tenantId,
      userId,
      parseResult.data
    );

    return reply.status(202).send(
      successResponse({ jobId: job.id, status: 'queued', estimatedRows: parseResult.data.rows.length }, request.id)
    );
  });
}
