/**
 * @file services/crm-service/src/routes/contacts.ts
 * @description Contacts resource — full CRUD, search, merge, activity feed.
 * All queries run through RLS-scoped db client (tenant_id enforced at DB level).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError, ConflictError } from '../middleware/error-handler';
import { ROLE_PERMISSIONS } from '../middleware/auth';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ContactCreateSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  jobTitle: z.string().max(200).optional(),
  department: z.string().max(200).optional(),
  accountId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(), // converted from lead
  linkedinUrl: z.string().url().optional(),
  timezone: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.unknown()).optional(),
});

const ContactUpdateSchema = ContactCreateSchema.partial();

const ContactSearchSchema = z.object({
  q: z.string().optional(),
  accountId: z.string().uuid().optional(),
  hasEmail: z.coerce.boolean().optional(),
  tags: z.string().optional(), // comma-separated
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'updatedAt', 'lastName', 'email']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function contactRoutes(fastify: FastifyInstance) {
  // ── List / Search ──────────────────────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const query = ContactSearchSchema.parse(request.query);
    const { db, tenantId } = request as any;

    const offset = (query.page - 1) * query.limit;

    // Build WHERE conditions
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (query.q) {
      conditions.push(`(
        c.first_name ILIKE $${paramIdx} OR
        c.last_name ILIKE $${paramIdx} OR
        c.email ILIKE $${paramIdx} OR
        (c.first_name || ' ' || c.last_name) ILIKE $${paramIdx}
      )`);
      params.push(`%${query.q}%`);
      paramIdx++;
    }
    if (query.accountId) {
      conditions.push(`c.account_id = $${paramIdx++}`);
      params.push(query.accountId);
    }
    if (query.hasEmail === true) {
      conditions.push('c.email IS NOT NULL');
    }
    if (query.tags) {
      const tags = query.tags.split(',').map(t => t.trim());
      conditions.push(`c.tags && $${paramIdx++}`);
      params.push(tags);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = {
      createdAt: 'c.created_at',
      updatedAt: 'c.updated_at',
      lastName: 'c.last_name',
      email: 'c.email',
    }[query.sort];

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           c.id, c.first_name, c.last_name, c.email, c.phone,
           c.job_title, c.department, c.linkedin_url, c.timezone,
           c.tags, c.created_at, c.updated_at,
           a.name AS account_name, a.id AS account_id
         FROM contacts c
         LEFT JOIN accounts a ON a.id = c.account_id
         ${whereClause}
         ORDER BY ${sortCol} ${query.order.toUpperCase()}
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, query.limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) AS total FROM contacts c ${whereClause}`,
        params
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return reply.send({
      success: true,
      data: {
        items: dataResult.rows.map(mapContactRow),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
          hasNext: query.page * query.limit < total,
          hasPrev: query.page > 1,
        },
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Get by ID ─────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { db } = request as any;

    const result = await db.query(
      `SELECT
         c.*,
         a.name AS account_name,
         a.domain AS account_domain,
         a.industry AS account_industry,
         (SELECT COUNT(*) FROM activities WHERE contact_id = c.id) AS activity_count,
         (SELECT COUNT(*) FROM deal_contacts dc WHERE dc.contact_id = c.id) AS deal_count
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE c.id = $1`,
      [request.params.id]
    );

    if (!result.rows[0]) {
      throw new NotFoundError('Contact', request.params.id);
    }

    return reply.send({
      success: true,
      data: mapContactDetailRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) {
      throw new ForbiddenError();
    }

    const body = ContactCreateSchema.parse(request.body);

    // Deduplicate by email within tenant (RLS handles tenant isolation)
    if (body.email) {
      const existing = await db.query(
        'SELECT id FROM contacts WHERE email = $1',
        [body.email.toLowerCase()]
      );
      if (existing.rows[0]) {
        throw new ConflictError(`Contact with email '${body.email}' already exists`);
      }
    }

    const result = await db.query(
      `INSERT INTO contacts (
         first_name, last_name, email, phone, job_title, department,
         account_id, lead_id, linkedin_url, timezone, tags, custom_fields,
         created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        body.firstName, body.lastName,
        body.email?.toLowerCase() ?? null,
        body.phone ?? null,
        body.jobTitle ?? null,
        body.department ?? null,
        body.accountId ?? null,
        body.leadId ?? null,
        body.linkedinUrl ?? null,
        body.timezone ?? null,
        body.tags ?? [],
        JSON.stringify(body.customFields ?? {}),
        userId,
      ]
    );

    return reply.code(201).send({
      success: true,
      data: mapContactRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) {
      throw new ForbiddenError();
    }

    const body = ContactUpdateSchema.parse(request.body);

    // Verify exists
    const existing = await db.query('SELECT id FROM contacts WHERE id = $1', [request.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Contact', request.params.id);

    // Email uniqueness check
    if (body.email) {
      const dup = await db.query(
        'SELECT id FROM contacts WHERE email = $1 AND id != $2',
        [body.email.toLowerCase(), request.params.id]
      );
      if (dup.rows[0]) throw new ConflictError(`Email '${body.email}' is already in use`);
    }

    // Build SET clause dynamically
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      phone: 'phone',
      jobTitle: 'job_title',
      department: 'department',
      accountId: 'account_id',
      linkedinUrl: 'linkedin_url',
      timezone: 'timezone',
      tags: 'tags',
      customFields: 'custom_fields',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((body as any)[key] !== undefined) {
        const val = (body as any)[key];
        updates.push(`${col} = $${idx++}`);
        params.push(key === 'email' ? val?.toLowerCase() : key === 'customFields' ? JSON.stringify(val) : val);
      }
    }

    if (updates.length === 0) {
      return reply.send({ success: true, data: existing.rows[0], timestamp: new Date().toISOString(), requestId: request.id });
    }

    updates.push(`updated_by = $${idx++}`);
    params.push(userId);
    params.push(request.params.id);

    const result = await db.query(
      `UPDATE contacts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    return reply.send({
      success: true,
      data: mapContactRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.settings?.write) {
      throw new ForbiddenError('Only admins can delete contacts');
    }

    const result = await db.query('DELETE FROM contacts WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) throw new NotFoundError('Contact', request.params.id);

    return reply.code(204).send();
  });

  // ── Activity Timeline ─────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id/timeline', async (request, reply) => {
    const { db } = request as any;

    const exists = await db.query('SELECT id FROM contacts WHERE id = $1', [request.params.id]);
    if (!exists.rows[0]) throw new NotFoundError('Contact', request.params.id);

    const result = await db.query(
      `SELECT
         a.id, a.type, a.subject, a.notes, a.outcome, a.duration_minutes,
         a.scheduled_at, a.completed_at, a.created_at,
         u.display_name AS created_by_name
       FROM activities a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.contact_id = $1
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [request.params.id]
    );

    return reply.send({
      success: true,
      data: result.rows,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Deals for Contact ────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id/deals', async (request, reply) => {
    const { db } = request as any;

    const exists = await db.query('SELECT id FROM contacts WHERE id = $1', [request.params.id]);
    if (!exists.rows[0]) throw new NotFoundError('Contact', request.params.id);

    const result = await db.query(
      `SELECT
         d.id, d.name, d.value, d.currency, d.probability, d.expected_close_date,
         d.created_at, ps.name AS stage_name, ps.stage_type
       FROM deal_contacts dc
       JOIN deals d ON d.id = dc.deal_id
       JOIN pipeline_stages ps ON ps.id = d.stage_id
       WHERE dc.contact_id = $1
       ORDER BY d.created_at DESC`,
      [request.params.id]
    );

    return reply.send({
      success: true,
      data: result.rows,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapContactRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`,
    email: row.email,
    phone: row.phone,
    jobTitle: row.job_title,
    department: row.department,
    accountId: row.account_id,
    accountName: row.account_name,
    linkedinUrl: row.linkedin_url,
    timezone: row.timezone,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContactDetailRow(row: Record<string, unknown>) {
  return {
    ...mapContactRow(row),
    accountDomain: row.account_domain,
    accountIndustry: row.account_industry,
    customFields: row.custom_fields ?? {},
    activityCount: Number(row.activity_count ?? 0),
    dealCount: Number(row.deal_count ?? 0),
  };
}
