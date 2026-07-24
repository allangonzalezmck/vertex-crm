/**
 * @file services/crm-service/src/routes/pipelines.ts
 * @description Pipelines resource — CRUD for sales pipelines and their stages.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ForbiddenError, ConflictError } from '../middleware/error-handler';
import { ROLE_PERMISSIONS } from '../middleware/auth';
import type { UserRole } from '../../../../shared/src/types/index.js';

const StageSchema = z.object({
  name: z.string().min(1).max(100),
  stageType: z.enum(['active', 'won', 'lost']).default('active'),
  probabilityDefault: z.number().int().min(0).max(100).default(50),
  displayOrder: z.number().int().min(0),
  color: z.string().optional(),
  rottenAfterDays: z.number().int().min(1).optional(),
});

const PipelineCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  isDefault: z.boolean().default(false),
  stages: z.array(StageSchema).min(2),
});

export async function pipelinesRouter(fastify: FastifyInstance) {
  // ── List ──────────────────────────────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const { db } = request as any;

    const result = await db.query(
      `SELECT
         p.id, p.name, p.description, p.is_default, p.created_at,
         (SELECT COUNT(*) FROM pipeline_stages WHERE pipeline_id = p.id) AS stage_count,
         (SELECT COUNT(*) FROM deals WHERE pipeline_id = p.id AND closed_at IS NULL) AS active_deal_count,
         (SELECT COALESCE(SUM(value), 0) FROM deals WHERE pipeline_id = p.id AND closed_at IS NULL) AS pipeline_value
       FROM pipelines p
       ORDER BY p.is_default DESC, p.created_at ASC`
    );

    return reply.send({
      success: true,
      data: result.rows,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Get with Stages ───────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { db } = request as any;

    const [pipelineResult, stagesResult] = await Promise.all([
      db.query('SELECT * FROM pipelines WHERE id = $1', [request.params.id]),
      db.query(
        `SELECT ps.*,
           (SELECT COUNT(*) FROM deals WHERE stage_id = ps.id AND closed_at IS NULL) AS deal_count
         FROM pipeline_stages ps
         WHERE ps.pipeline_id = $1
         ORDER BY ps.display_order ASC`,
        [request.params.id]
      ),
    ]);

    if (!pipelineResult.rows[0]) throw new NotFoundError('Pipeline', request.params.id);

    return reply.send({
      success: true,
      data: {
        ...pipelineResult.rows[0],
        stages: stagesResult.rows.map((s: Record<string, unknown>) => ({
          ...s,
          dealCount: Number(s.deal_count),
        })),
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('admin:write')) throw new ForbiddenError();

    const body = PipelineCreateSchema.parse(request.body);

    // If marking as default, unset others
    if (body.isDefault) {
      await db.query('UPDATE pipelines SET is_default = false');
    }

    const pipeline = await db.query(
      `INSERT INTO pipelines (name, description, is_default, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.name, body.description ?? null, body.isDefault, userId]
    );

    // Insert stages
    const stageInserts = body.stages.map((stage, i) =>
      db.query(
        `INSERT INTO pipeline_stages (
           pipeline_id, name, stage_type, probability_default,
           display_order, color, rotten_after_days
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          pipeline.rows[0].id, stage.name, stage.stageType,
          stage.probabilityDefault, i, stage.color ?? null,
          stage.rottenAfterDays ?? null,
        ]
      )
    );

    const stageResults = await Promise.all(stageInserts);

    return reply.code(201).send({
      success: true,
      data: {
        ...pipeline.rows[0],
        stages: stageResults.map(r => r.rows[0]),
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, userId, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('admin:write')) throw new ForbiddenError();

    const body = PipelineCreateSchema.partial().parse(request.body);

    const existing = await db.query('SELECT id FROM pipelines WHERE id = $1', [request.params.id]);
    if (!existing.rows[0]) throw new NotFoundError('Pipeline', request.params.id);

    if (body.isDefault) {
      await db.query('UPDATE pipelines SET is_default = false WHERE id != $1', [request.params.id]);
    }

    const result = await db.query(
      `UPDATE pipelines SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         is_default = COALESCE($3, is_default),
         updated_by = $4
       WHERE id = $5 RETURNING *`,
      [body.name ?? null, body.description ?? null, body.isDefault ?? null, userId, request.params.id]
    );

    return reply.send({
      success: true,
      data: result.rows[0],
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { userRole, db } = request as any;
    if (!ROLE_PERMISSIONS[userRole as UserRole]?.includes('admin:write')) throw new ForbiddenError();

    // Check for active deals
    const dealsCheck = await db.query(
      'SELECT COUNT(*) AS cnt FROM deals WHERE pipeline_id = $1',
      [request.params.id]
    );
    if (Number(dealsCheck.rows[0].cnt) > 0) {
      throw new ConflictError('Cannot delete pipeline with existing deals');
    }

    const result = await db.query('DELETE FROM pipelines WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) throw new NotFoundError('Pipeline', request.params.id);

    return reply.code(204).send();
  });
}
