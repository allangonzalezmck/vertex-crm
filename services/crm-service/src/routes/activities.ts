/**
 * @file services/crm-service/src/routes/activities.ts
 * @description Activities resource — calls, emails, meetings, tasks.
 * Supports scheduling, completion tracking, and linking to leads/contacts/deals.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError } from '../middleware/error-handler';
import { ROLE_PERMISSIONS } from '../middleware/auth';
import type { UserRole } from '../../../../shared/src/types/index.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ActivityType = z.enum(['call', 'email', 'meeting', 'task', 'note', 'sms', 'demo']);
const ActivityOutcome = z.enum([
  'connected', 'voicemail', 'no_answer', 'busy',
  'sent', 'opened', 'replied', 'bounced',
  'completed', 'cancelled', 'no_show',
  'pending',
]);

const ActivityCreateSchemaBase = z.object({
  type: ActivityType,
  subject: z.string().min(1).max(500),
  notes: z.string().optional(),
  outcome: ActivityOutcome.optional(),
  durationMinutes: z.number().int().min(1).max(600).optional(),
  scheduledAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  // Associations (at least one required)
  leadId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
  // For tasks
  dueDate: z.string().datetime().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

const ActivityCreateSchema = ActivityCreateSchemaBase.refine(
  data => data.leadId || data.contactId || data.dealId || data.accountId,
  { message: 'At least one association (leadId, contactId, dealId, accountId) is required' }
);

const ActivityUpdateSchema = ActivityCreateSchemaBase.partial().omit({ type: true });

const ActivityListSchema = z.object({
  type: ActivityType.optional(),
  leadId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
  completed: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  scheduledFrom: z.string().optional(),
  scheduledTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'scheduledAt', 'completedAt', 'dueDate']).default('scheduledAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function activitiesRouter(fastify: FastifyInstance) {
  // ── List Activities ────────────────────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const query = ActivityListSchema.parse(request.query);
    const { db } = request as any;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (query.type) { conditions.push(`a.type = $${idx++}`); params.push(query.type); }
    if (query.leadId) { conditions.push(`a.lead_id = $${idx++}`); params.push(query.leadId); }
    if (query.contactId) { conditions.push(`a.contact_id = $${idx++}`); params.push(query.contactId); }
    if (query.dealId) { conditions.push(`a.deal_id = $${idx++}`); params.push(query.dealId); }
    if (query.accountId) { conditions.push(`a.account_id = $${idx++}`); params.push(query.accountId); }
    if (query.assignedToId) { conditions.push(`a.assigned_to_id = $${idx++}`); params.push(query.assignedToId); }
    if (query.completed === true) { conditions.push('a.completed_at IS NOT NULL'); }
    if (query.completed === false) { conditions.push('a.completed_at IS NULL'); }
    if (query.overdue === true) {
      conditions.push('a.due_date < NOW() AND a.completed_at IS NULL');
    }
    if (query.scheduledFrom) { conditions.push(`a.scheduled_at >= $${idx++}`); params.push(query.scheduledFrom); }
    if (query.scheduledTo) { conditions.push(`a.scheduled_at <= $${idx++}`); params.push(query.scheduledTo); }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortMap: Record<string, string> = {
      createdAt: 'a.created_at',
      scheduledAt: 'a.scheduled_at',
      completedAt: 'a.completed_at',
      dueDate: 'a.due_date',
    };
    const offset = (query.page - 1) * query.limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           a.id, a.type, a.subject, a.notes, a.outcome,
           a.duration_minutes, a.scheduled_at, a.completed_at,
           a.due_date, a.priority, a.created_at,
           a.lead_id, a.contact_id, a.deal_id, a.account_id,
           u_created.display_name AS created_by_name,
           u_assigned.display_name AS assigned_to_name,
           l.first_name AS lead_first_name, l.last_name AS lead_last_name,
           c.first_name AS contact_first_name, c.last_name AS contact_last_name,
           d.name AS deal_name
         FROM activities a
         LEFT JOIN users u_created ON u_created.id = a.created_by
         LEFT JOIN users u_assigned ON u_assigned.id = a.assigned_to_id
         LEFT JOIN leads l ON l.id = a.lead_id
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN deals d ON d.id = a.deal_id
         ${whereClause}
         ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()} NULLS LAST
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, query.limit, offset]
      ),
      db.query(`SELECT COUNT(*) AS total FROM activities a ${whereClause}`, params),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return reply.send({
      success: true,
      data: {
        items: dataResult.rows.map(mapActivityRow),
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

  // ── Upcoming / Today's activities ─────────────────────────────────────────
  fastify.get('/upcoming', async (request: any, reply) => {
    const { db, userId } = request;

    const result = await db.query(
      `SELECT
         a.id, a.type, a.subject, a.scheduled_at, a.due_date, a.priority,
         a.lead_id, a.contact_id, a.deal_id,
         COALESCE(
           l.first_name || ' ' || l.last_name,
           c.first_name || ' ' || c.last_name,
           d.name
         ) AS related_name
       FROM activities a
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN deals d ON d.id = a.deal_id
       WHERE
         a.completed_at IS NULL
         AND (a.assigned_to_id = $1 OR a.created_by = $1)
         AND (
           a.scheduled_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
           OR a.due_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
           OR (a.due_date < NOW() AND a.completed_at IS NULL)
         )
       ORDER BY COALESCE(a.scheduled_at, a.due_date) ASC
       LIMIT 50`,
      [userId]
    );

    return reply.send({
      success: true,
      data: result.rows,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Get by ID ─────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { db } = request as any;

    const result = await db.query(
      `SELECT a.*,
         u_created.display_name AS created_by_name,
         u_assigned.display_name AS assigned_to_name
       FROM activities a
       LEFT JOIN users u_created ON u_created.id = a.created_by
       LEFT JOIN users u_assigned ON u_assigned.id = a.assigned_to_id
       WHERE a.id = $1`,
      [request.params.id]
    );

    if (!result.rows[0]) throw new NotFoundError('Activity', request.params.id);

    return reply.send({
      success: true,
      data: mapActivityDetailRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('leads:write')) throw new ForbiddenError();

    const body = ActivityCreateSchema.parse(request.body);

    const result = await db.query(
      `INSERT INTO activities (
         type, subject, notes, outcome, duration_minutes,
         scheduled_at, completed_at, due_date, priority,
         lead_id, contact_id, deal_id, account_id,
         assigned_to_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        body.type, body.subject, body.notes ?? null,
        body.outcome ?? null, body.durationMinutes ?? null,
        body.scheduledAt ?? null, body.completedAt ?? null,
        body.dueDate ?? null, body.priority ?? 'medium',
        body.leadId ?? null, body.contactId ?? null,
        body.dealId ?? null, body.accountId ?? null,
        body.assignedToId ?? userId, userId,
      ]
    );

    return reply.code(201).send({
      success: true,
      data: mapActivityRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Complete Activity ──────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>('/:id/complete', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('leads:write')) throw new ForbiddenError();

    const body = z.object({
      outcome: ActivityOutcome.optional(),
      notes: z.string().optional(),
      durationMinutes: z.number().int().min(1).optional(),
    }).parse(request.body);

    const existing = await db.query('SELECT id FROM activities WHERE id = $1', [request.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Activity', request.params.id);

    const result = await db.query(
      `UPDATE activities SET
         completed_at = NOW(),
         outcome = COALESCE($1, outcome),
         notes = COALESCE($2, notes),
         duration_minutes = COALESCE($3, duration_minutes),
         updated_by = $4
       WHERE id = $5
       RETURNING *`,
      [body.outcome ?? null, body.notes ?? null, body.durationMinutes ?? null, userId, request.params.id]
    );

    return reply.send({
      success: true,
      data: mapActivityRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('leads:write')) throw new ForbiddenError();

    const body = ActivityUpdateSchema.parse(request.body);

    const existing = await db.query('SELECT id FROM activities WHERE id = $1', [request.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Activity', request.params.id);

    const fieldMap: Record<string, string> = {
      subject: 'subject', notes: 'notes', outcome: 'outcome',
      durationMinutes: 'duration_minutes', scheduledAt: 'scheduled_at',
      completedAt: 'completed_at', dueDate: 'due_date', priority: 'priority',
      assignedToId: 'assigned_to_id',
    };

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((body as any)[key] !== undefined) {
        updates.push(`${col} = $${idx++}`);
        params.push((body as any)[key]);
      }
    }

    if (!updates.length) {
      return reply.send({ success: true, data: {}, timestamp: new Date().toISOString(), requestId: request.id });
    }

    updates.push(`updated_by = $${idx++}`);
    params.push(userId);
    params.push(request.params.id);

    const result = await db.query(
      `UPDATE activities SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    return reply.send({
      success: true,
      data: mapActivityRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('leads:write')) throw new ForbiddenError();

    const result = await db.query('DELETE FROM activities WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) throw new NotFoundError('Activity', request.params.id);

    return reply.code(204).send();
  });
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapActivityRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    notes: row.notes,
    outcome: row.outcome,
    durationMinutes: row.duration_minutes,
    scheduledAt: row.scheduled_at,
    completedAt: row.completed_at,
    dueDate: row.due_date,
    priority: row.priority,
    leadId: row.lead_id,
    contactId: row.contact_id,
    dealId: row.deal_id,
    accountId: row.account_id,
    assignedToId: row.assigned_to_id,
    createdByName: row.created_by_name,
    assignedToName: row.assigned_to_name,
    // Denormalized related names
    leadName: row.lead_first_name ? `${row.lead_first_name} ${row.lead_last_name}` : null,
    contactName: row.contact_first_name ? `${row.contact_first_name} ${row.contact_last_name}` : null,
    dealName: row.deal_name ?? null,
    createdAt: row.created_at,
  };
}

function mapActivityDetailRow(row: Record<string, unknown>) {
  return {
    ...mapActivityRow(row),
    assignedToId: row.assigned_to_id,
    updatedAt: row.updated_at,
  };
}
