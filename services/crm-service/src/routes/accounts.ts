/**
 * @file services/crm-service/src/routes/accounts.ts
 * @description Accounts (companies/organizations) resource — CRUD,
 * contacts association, deals, revenue overview.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError, ConflictError } from '../middleware/error-handler';
import { ROLE_PERMISSIONS } from '../middleware/auth';

const AccountCreateSchema = z.object({
  name: z.string().min(1).max(255),
  domain: z.string().max(255).optional(),
  industry: z.string().max(100).optional(),
  employeeCount: z.number().int().min(1).optional(),
  annualRevenue: z.number().nonnegative().optional(),
  currency: z.string().length(3).default('USD'),
  website: z.string().url().optional(),
  phone: z.string().max(50).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  timezone: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.unknown()).optional(),
});

const AccountUpdateSchema = AccountCreateSchema.partial();

const AccountListSchema = z.object({
  q: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  tags: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'annualRevenue']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export async function accountRoutes(fastify: FastifyInstance) {
  // ── List ──────────────────────────────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const query = AccountListSchema.parse(request.query);
    const { db } = request as any;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (query.q) {
      conditions.push(`(a.name ILIKE $${idx} OR a.domain ILIKE $${idx})`);
      params.push(`%${query.q}%`);
      idx++;
    }
    if (query.industry) { conditions.push(`a.industry = $${idx++}`); params.push(query.industry); }
    if (query.country) { conditions.push(`a.country = $${idx++}`); params.push(query.country); }
    if (query.tags) {
      const tags = query.tags.split(',').map(t => t.trim());
      conditions.push(`a.tags && $${idx++}`);
      params.push(tags);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortMap: Record<string, string> = {
      name: 'a.name',
      createdAt: 'a.created_at',
      updatedAt: 'a.updated_at',
      annualRevenue: 'a.annual_revenue',
    };
    const offset = (query.page - 1) * query.limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           a.id, a.name, a.domain, a.industry, a.employee_count,
           a.annual_revenue, a.currency, a.website, a.country, a.city,
           a.tags, a.created_at, a.updated_at,
           (SELECT COUNT(*) FROM contacts WHERE account_id = a.id) AS contact_count,
           (SELECT COUNT(*) FROM deals WHERE account_id = a.id AND closed_at IS NULL) AS open_deal_count,
           (SELECT COALESCE(SUM(value), 0) FROM deals WHERE account_id = a.id AND closed_at IS NULL) AS open_deal_value
         FROM accounts a
         ${whereClause}
         ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()}
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, query.limit, offset]
      ),
      db.query(`SELECT COUNT(*) AS total FROM accounts a ${whereClause}`, params),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return reply.send({
      success: true,
      data: {
        items: dataResult.rows.map(mapAccountRow),
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Get ───────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { db } = request as any;

    const result = await db.query(
      `SELECT
         a.*,
         (SELECT COUNT(*) FROM contacts WHERE account_id = a.id) AS contact_count,
         (SELECT COUNT(*) FROM deals WHERE account_id = a.id) AS deal_count,
         (SELECT COALESCE(SUM(value), 0) FROM deals WHERE account_id = a.id AND closed_at IS NOT NULL) AS total_closed_value,
         (SELECT COALESCE(SUM(value), 0) FROM deals WHERE account_id = a.id AND closed_at IS NULL) AS open_pipeline_value
       FROM accounts a
       WHERE a.id = $1`,
      [request.params.id]
    );

    if (!result.rows[0]) throw new NotFoundError('Account', request.params.id);

    return reply.send({
      success: true,
      data: mapAccountDetailRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) throw new ForbiddenError();

    const body = AccountCreateSchema.parse(request.body);

    // Deduplicate by domain within tenant
    if (body.domain) {
      const existing = await db.query('SELECT id FROM accounts WHERE domain = $1', [body.domain.toLowerCase()]);
      if (existing.rows[0]) throw new ConflictError(`Account with domain '${body.domain}' already exists`);
    }

    const result = await db.query(
      `INSERT INTO accounts (
         name, domain, industry, employee_count, annual_revenue, currency,
         website, phone, country, city, timezone, linkedin_url, description,
         tags, custom_fields, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        body.name, body.domain?.toLowerCase() ?? null,
        body.industry ?? null, body.employeeCount ?? null,
        body.annualRevenue ?? null, body.currency,
        body.website ?? null, body.phone ?? null,
        body.country ?? null, body.city ?? null,
        body.timezone ?? null, body.linkedinUrl ?? null,
        body.description ?? null, body.tags ?? [],
        JSON.stringify(body.customFields ?? {}), userId,
      ]
    );

    return reply.code(201).send({
      success: true,
      data: mapAccountRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.leads?.write) throw new ForbiddenError();

    const body = AccountUpdateSchema.parse(request.body);

    const existing = await db.query('SELECT id FROM accounts WHERE id = $1', [request.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Account', request.params.id);

    if (body.domain) {
      const dup = await db.query('SELECT id FROM accounts WHERE domain = $1 AND id != $2', [body.domain.toLowerCase(), request.params.id]);
      if (dup.rows[0]) throw new ConflictError(`Domain '${body.domain}' is already in use`);
    }

    const fieldMap: Record<string, string> = {
      name: 'name', domain: 'domain', industry: 'industry',
      employeeCount: 'employee_count', annualRevenue: 'annual_revenue',
      currency: 'currency', website: 'website', phone: 'phone',
      country: 'country', city: 'city', timezone: 'timezone',
      linkedinUrl: 'linkedin_url', description: 'description',
      tags: 'tags', customFields: 'custom_fields',
    };

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((body as any)[key] !== undefined) {
        updates.push(`${col} = $${idx++}`);
        const val = (body as any)[key];
        params.push(key === 'domain' ? val?.toLowerCase() : key === 'customFields' ? JSON.stringify(val) : val);
      }
    }

    if (!updates.length) {
      return reply.send({ success: true, data: {}, timestamp: new Date().toISOString(), requestId: request.id });
    }

    updates.push(`updated_by = $${idx++}`);
    params.push(userId);
    params.push(request.params.id);

    const result = await db.query(
      `UPDATE accounts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    return reply.send({
      success: true,
      data: mapAccountRow(result.rows[0]),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Contacts for Account ──────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id/contacts', async (request, reply) => {
    const { db } = request as any;

    const exists = await db.query('SELECT id FROM accounts WHERE id = $1', [request.params.id]);
    if (!exists.rows[0]) throw new NotFoundError('Account', request.params.id);

    const result = await db.query(
      `SELECT id, first_name, last_name, email, phone, job_title, created_at
       FROM contacts WHERE account_id = $1 ORDER BY last_name ASC`,
      [request.params.id]
    );

    return reply.send({
      success: true,
      data: result.rows.map(r => ({
        ...r,
        fullName: `${r.first_name} ${r.last_name}`,
      })),
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole]?.settings?.write) throw new ForbiddenError();

    const result = await db.query('DELETE FROM accounts WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) throw new NotFoundError('Account', request.params.id);

    return reply.code(204).send();
  });
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapAccountRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    employeeCount: row.employee_count,
    annualRevenue: row.annual_revenue ? Number(row.annual_revenue) : null,
    currency: row.currency,
    website: row.website,
    country: row.country,
    city: row.city,
    tags: row.tags ?? [],
    contactCount: Number(row.contact_count ?? 0),
    openDealCount: Number(row.open_deal_count ?? 0),
    openDealValue: Number(row.open_deal_value ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccountDetailRow(row: Record<string, unknown>) {
  return {
    ...mapAccountRow(row),
    phone: row.phone,
    timezone: row.timezone,
    linkedinUrl: row.linkedin_url,
    description: row.description,
    customFields: row.custom_fields ?? {},
    dealCount: Number(row.deal_count ?? 0),
    totalClosedValue: Number(row.total_closed_value ?? 0),
    openPipelineValue: Number(row.open_pipeline_value ?? 0),
  };
}
