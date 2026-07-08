/**
 * @file services/crm-service/src/routes/deals.ts
 * @description Deals resource — pipeline management, stage transitions,
 * revenue forecasting, contact associations, activity logging.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { ROLE_PERMISSIONS } from '../middleware/auth';
import { publishEvent } from '@vertex/shared/utils/pubsub';
import { TOPICS } from '@vertex/shared/utils/pubsub';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const DealCreateSchema = z.object({
  name: z.string().min(1).max(255),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).default('USD'),
  pipelineId: z.string().uuid(),
  stageId: z.string().uuid(),
  accountId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseDate: z.string().datetime().optional(),
  source: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  contactIds: z.array(z.string().uuid()).optional(),
  customFields: z.record(z.unknown()).optional(),
});

const DealUpdateSchema = DealCreateSchema.partial().omit({ pipelineId: true });

const DealStageChangeSchema = z.object({
  stageId: z.string().uuid(),
  reason: z.string().optional(),
});

const DealListSchema = z.object({
  pipelineId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  minValue: z.coerce.number().optional(),
  maxValue: z.coerce.number().optional(),
  closingBefore: z.string().optional(),
  closingAfter: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'updatedAt', 'value', 'expectedCloseDate', 'probability']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function dealRoutes(fastify: FastifyInstance) {
  // ── List Deals ─────────────────────────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const query = DealListSchema.parse(request.query);
    const { db } = request as any;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (query.q) {
      conditions.push(`d.name ILIKE $${idx++}`);
      params.push(`%${query.q}%`);
    }
    if (query.pipelineId) {
      conditions.push(`d.pipeline_id = $${idx++}`);
      params.push(query.pipelineId);
    }
    if (query.stageId) {
      conditions.push(`d.stage_id = $${idx++}`);
      params.push(query.stageId);
    }
    if (query.ownerId) {
      conditions.push(`d.owner_id = $${idx++}`);
      params.push(query.ownerId);
    }
    if (query.accountId) {
      conditions.push(`d.account_id = $${idx++}`);
      params.push(query.accountId);
    }
    if (query.minValue !== undefined) {
      conditions.push(`d.value >= $${idx++}`);
      params.push(query.minValue);
    }
    if (query.maxValue !== undefined) {
      conditions.push(`d.value <= $${idx++}`);
      params.push(query.maxValue);
    }
    if (query.closingBefore) {
      conditions.push(`d.expected_close_date <= $${idx++}`);
      params.push(query.closingBefore);
    }
    if (query.closingAfter) {
      conditions.push(`d.expected_close_date >= $${idx++}`);
      params.push(query.closingAfter);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortMap: Record<string, string> = {
      createdAt: 'd.created_at',
      updatedAt: 'd.updated_at',
      value: 'd.value',
      expectedCloseDate: 'd.expected_close_date',
      probability: 'd.probability',
    };
    const offset = (query.page - 1) * query.limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           d.id, d.name, d.value, d.currency, d.probability,
           d.expected_close_date, d.tags, d.source, d.created_at, d.updated_at,
           ps.name AS stage_name, ps.stage_type, ps.display_order AS stage_order,
           p.name AS pipeline_name,
           a.name AS account_name,
           u.display_name AS owner_name,
           (SELECT COUNT(*) FROM deal_contacts WHERE deal_id = d.id) AS contact_count
         FROM deals d
         JOIN pipeline_stages ps ON ps.id = d.stage_id
         JOIN pipelines p ON p.id = d.pipeline_id
         LEFT JOIN accounts a ON a.id = d.account_id
         LEFT JOIN users u ON u.id = d.owner_id
         ${whereClause}
         ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()}
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, query.limit, offset]
      ),
      db.query(`SELECT COUNT(*) AS total FROM deals d ${whereClause}`, params),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return reply.send({
      success: true,
      data: {
        items: dataResult.rows.map(mapDealRow),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Pipeline Board View (Kanban) ───────────────────────────────────────────
  fastify.get('/board/:pipelineId', async (request: any, reply) => {
    const { db } = request;
    const { pipelineId } = request.params;

    // Verify pipeline exists
    const pipeline = await db.query('SELECT * FROM pipelines WHERE id = $1', [pipelineId]);
    if (!pipeline.rows[0]) throw new NotFoundError('Pipeline', pipelineId);

    // Fetch all stages with deals aggregated
    const stagesResult = await db.query(
      `SELECT
         ps.id, ps.name, ps.stage_type, ps.display_order, ps.probability_default,
         ps.color,
         COALESCE(json_agg(
           json_build_object(
             'id', d.id,
             'name', d.name,
             'value', d.value,
             'currency', d.currency,
             'probability', d.probability,
             'accountName', a.name,
             'ownerName', u.display_name,
             'expectedCloseDate', d.expected_close_date,
             'tags', d.tags,
             'updatedAt', d.updated_at
           ) ORDER BY d.created_at DESC
         ) FILTER (WHERE d.id IS NOT NULL), '[]'::json) AS deals,
         COUNT(d.id) AS deal_count,
         COALESCE(SUM(d.value), 0) AS total_value
       FROM pipeline_stages ps
       LEFT JOIN deals d ON d.stage_id = ps.id
       LEFT JOIN accounts a ON a.id = d.account_id
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE ps.pipeline_id = $1
       GROUP BY ps.id
       ORDER BY ps.display_order ASC`,
      [pipelineId]
    );

    return reply.send({
      success: true,
      data: {
        pipeline: pipeline.rows[0],
        stages: stagesResult.rows.map(s => ({
          id: s.id,
          name: s.name,
          stageType: s.stage_type,
          displayOrder: s.display_order,
          probabilityDefault: s.probability_default,
          color: s.color,
          deals: s.deals,
          dealCount: Number(s.deal_count),
          totalValue: Number(s.total_value),
        })),
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Revenue Forecast ──────────────────────────────────────────────────────
  fastify.get('/forecast', async (request: any, reply) => {
    const { db } = request;
    const { pipelineId, month } = request.query as any;

    const targetMonth = month ? new Date(month) : new Date();

    const result = await db.query(
      `SELECT
         ps.name AS stage_name,
         ps.stage_type,
         COUNT(d.id) AS deal_count,
         SUM(d.value) AS total_value,
         SUM(d.value * d.probability / 100) AS weighted_value,
         SUM(CASE WHEN ps.stage_type = 'won' THEN d.value ELSE 0 END) AS closed_won_value
       FROM deals d
       JOIN pipeline_stages ps ON ps.id = d.stage_id
       WHERE
         ($1::uuid IS NULL OR d.pipeline_id = $1)
         AND EXTRACT(YEAR FROM d.expected_close_date) = $2
         AND EXTRACT(MONTH FROM d.expected_close_date) = $3
       GROUP BY ps.id, ps.name, ps.stage_type
       ORDER BY ps.display_order`,
      [pipelineId ?? null, targetMonth.getFullYear(), targetMonth.getMonth() + 1]
    );

    const summary = result.rows.reduce(
      (acc, row) => {
        acc.totalPipeline += Number(row.total_value ?? 0);
        acc.weightedForecast += Number(row.weighted_value ?? 0);
        acc.closedWon += Number(row.closed_won_value ?? 0);
        acc.totalDeals += Number(row.deal_count ?? 0);
        return acc;
      },
      { totalPipeline: 0, weightedForecast: 0, closedWon: 0, totalDeals: 0 }
    );

    return reply.send({
      success: true,
      data: { summary, byStage: result.rows },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Get Deal ──────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { db } = request as any;

    const result = await db.query(
      `SELECT
         d.*,
         ps.name AS stage_name, ps.stage_type, ps.color AS stage_color,
         p.name AS pipeline_name,
         a.name AS account_name, a.domain AS account_domain,
         u.display_name AS owner_name, u.email AS owner_email,
         (
           SELECT json_agg(json_build_object(
             'id', c.id, 'firstName', c.first_name, 'lastName', c.last_name,
             'email', c.email, 'jobTitle', c.job_title, 'isPrimary', dc.is_primary
           ))
           FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id
           WHERE dc.deal_id = d.id
         ) AS contacts
       FROM deals d
       JOIN pipeline_stages ps ON ps.id = d.stage_id
       JOIN pipelines p ON p.id = d.pipeline_id
       LEFT JOIN accounts a ON a.id = d.account_id
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.id = $1`,
      [request.params.id]
    );

    if (!result.rows[0]) throw new NotFoundError('Deal', request.params.id);

    return reply.send({
      success: true,
      data: mapDealDetailRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Create Deal ───────────────────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const { userRole, userId, tenantId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) throw new ForbiddenError();

    const body = DealCreateSchema.parse(request.body);

    // Verify stage belongs to pipeline
    const stageCheck = await db.query(
      'SELECT id, probability_default FROM pipeline_stages WHERE id = $1 AND pipeline_id = $2',
      [body.stageId, body.pipelineId]
    );
    if (!stageCheck.rows[0]) throw new NotFoundError('Pipeline stage', body.stageId);

    const probability = body.probability ?? stageCheck.rows[0].probability_default ?? 50;

    const result = await db.query(
      `INSERT INTO deals (
         name, value, currency, pipeline_id, stage_id, account_id,
         owner_id, probability, expected_close_date, source, description,
         tags, custom_fields, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        body.name, body.value ?? null, body.currency, body.pipelineId,
        body.stageId, body.accountId ?? null,
        body.ownerId ?? userId, probability,
        body.expectedCloseDate ?? null, body.source ?? null,
        body.description ?? null, body.tags ?? [],
        JSON.stringify(body.customFields ?? {}), userId,
      ]
    );

    const deal = result.rows[0];

    // Associate contacts
    if (body.contactIds?.length) {
      const contactValues = body.contactIds.map((cid, i) =>
        `($1, $${i + 2}, ${i === 0})`
      ).join(', ');
      await db.query(
        `INSERT INTO deal_contacts (deal_id, contact_id, is_primary) VALUES ${contactValues}
         ON CONFLICT DO NOTHING`,
        [deal.id, ...body.contactIds]
      );
    }

    // Publish event
    await publishEvent(TOPICS.CRM_EVENTS, {
      type: 'deal.created',
      tenantId,
      payload: { dealId: deal.id, value: deal.value, stageId: deal.stage_id },
      timestamp: new Date().toISOString(),
      traceId: request.id,
    });

    return reply.code(201).send({
      success: true,
      data: mapDealRow(deal),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Update Deal ───────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) throw new ForbiddenError();

    const body = DealUpdateSchema.parse(request.body);

    const existing = await db.query('SELECT * FROM deals WHERE id = $1', [request.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Deal', request.params.id);

    const fieldMap: Record<string, string> = {
      name: 'name', value: 'value', currency: 'currency',
      stageId: 'stage_id', accountId: 'account_id', ownerId: 'owner_id',
      probability: 'probability', expectedCloseDate: 'expected_close_date',
      source: 'source', description: 'description',
      tags: 'tags', customFields: 'custom_fields',
    };

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((body as any)[key] !== undefined) {
        updates.push(`${col} = $${idx++}`);
        const val = (body as any)[key];
        params.push(key === 'customFields' ? JSON.stringify(val) : val);
      }
    }

    if (!updates.length) {
      return reply.send({ success: true, data: mapDealRow(existing.rows[0]), timestamp: new Date().toISOString(), requestId: request.id });
    }

    updates.push(`updated_by = $${idx++}`);
    params.push(userId);
    params.push(request.params.id);

    const result = await db.query(
      `UPDATE deals SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    return reply.send({
      success: true,
      data: mapDealRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Stage Transition ──────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/stage', async (request, reply) => {
    const { userRole, userId, tenantId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) throw new ForbiddenError();

    const body = DealStageChangeSchema.parse(request.body);

    const deal = await db.query('SELECT * FROM deals WHERE id = $1', [request.params.id]);
    if (!deal.rows[0]) throw new NotFoundError('Deal', request.params.id);

    const stage = await db.query(
      'SELECT id, name, stage_type, probability_default FROM pipeline_stages WHERE id = $1',
      [body.stageId]
    );
    if (!stage.rows[0]) throw new NotFoundError('Stage', body.stageId);

    const oldStageId = deal.rows[0].stage_id;
    const newProbability = stage.rows[0].stage_type === 'won' ? 100
      : stage.rows[0].stage_type === 'lost' ? 0
      : deal.rows[0].probability;

    const result = await db.query(
      `UPDATE deals SET
         stage_id = $1,
         probability = $2,
         updated_by = $3,
         closed_at = CASE WHEN $4 IN ('won', 'lost') THEN NOW() ELSE closed_at END
       WHERE id = $5
       RETURNING *`,
      [body.stageId, newProbability, userId, stage.rows[0].stage_type, request.params.id]
    );

    await publishEvent(TOPICS.CRM_EVENTS, {
      type: 'deal.stage_changed',
      tenantId,
      payload: {
        dealId: request.params.id,
        fromStageId: oldStageId,
        toStageId: body.stageId,
        stageType: stage.rows[0].stage_type,
        dealValue: deal.rows[0].value,
        reason: body.reason,
      },
      timestamp: new Date().toISOString(),
      traceId: request.id,
    });

    return reply.send({
      success: true,
      data: mapDealRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Delete Deal ───────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.settings?.write) {
      throw new ForbiddenError('Only admins can delete deals');
    }

    const result = await db.query('DELETE FROM deals WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) throw new NotFoundError('Deal', request.params.id);

    return reply.code(204).send();
  });
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapDealRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    value: row.value ? Number(row.value) : null,
    currency: row.currency,
    probability: row.probability,
    expectedCloseDate: row.expected_close_date,
    stageName: row.stage_name,
    stageType: row.stage_type,
    stageOrder: row.stage_order,
    pipelineName: row.pipeline_name,
    accountId: row.account_id,
    accountName: row.account_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    source: row.source,
    tags: row.tags ?? [],
    contactCount: Number(row.contact_count ?? 0),
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDealDetailRow(row: Record<string, unknown>) {
  return {
    ...mapDealRow(row),
    description: row.description,
    customFields: row.custom_fields ?? {},
    stageColor: row.stage_color,
    accountDomain: row.account_domain,
    ownerEmail: row.owner_email,
    contacts: row.contacts ?? [],
  };
}
