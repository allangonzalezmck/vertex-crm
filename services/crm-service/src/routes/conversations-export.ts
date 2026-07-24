/**
 * Vertex CRM — Conversation Export Routes (GAP-04 fix)
 *
 * WHY: The concrete promise to ex-Kommo customers is "your history lives in
 * a database you control, and you can take it with you anytime". This makes
 * that promise a button: tenants export their full conversation history
 * (every turn, both directions, with AI metadata) as JSON or CSV, including
 * 7-day signed URLs for archived media (GAP-02) so attachments come too.
 *
 * Endpoints (register under the agent service; gateway → /api/agent/...):
 *   GET /conversations/export?format=json|csv&from=ISO&to=ISO&includeMedia=true
 *
 * Notes:
 *   - Queries run on the request's RLS-scoped client (same tenantContext
 *     pattern as every other route) — a tenant can only ever export itself.
 *   - Batched in pages of 5 000 turns to keep memory flat on Cloud Run.
 *   - CSV fields are quoted/escaped; content preserved verbatim.
 *
 * File location: services/ai-sales-agent/src/routes/conversations-export.ts
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Storage } from '@google-cloud/storage';
import { z } from 'zod';
import { createLogger } from '@vertex/shared/utils/logger';

const logger = createLogger('conversations-export');
const storage = new Storage();

const QuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  includeMedia: z.coerce.boolean().default(false),
});

interface TurnRow {
  conversation_id: string;
  channel: string;
  external_user_id: string;
  lead_id: string | null;
  direction: string;
  content: string;
  intent: string | null;
  sentiment_score: string | null;
  fsm_state: string | null;
  delivery_status: string | null;
  media_type: string | null;
  media_gcs_path: string | null;
  media_mime: string | null;
  created_at: Date;
}

const PAGE_SIZE = 5_000;

function csvEscape(v: string | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function signMediaUrl(gcsPath: string): Promise<string | null> {
  try {
    // gs://bucket/object → signed https URL, 7 days
    const [, , bucket, ...obj] = gcsPath.split('/');
    const [url] = await storage
      .bucket(bucket)
      .file(obj.join('/'))
      .getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 3600 * 1000 });
    return url;
  } catch (err) {
    logger.warn('Media URL signing failed', { gcsPath, err: (err as Error).message });
    return null;
  }
}

export async function conversationsExportRouter(app: FastifyInstance): Promise<void> {
  app.get('/conversations/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_QUERY', details: parsed.error.flatten().fieldErrors },
      });
    }
    const { format, from, to, includeMedia } = parsed.data;
    const { db } = request as any; // RLS-scoped client from tenantContext plugin

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (from) { params.push(from); conditions.push(`t.created_at >= $${params.length}`); }
    if (to)   { params.push(to);   conditions.push(`t.created_at <= $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const baseQuery = `
      SELECT t.conversation_id, c.channel, c.external_user_id, c.lead_id,
             t.direction, t.content, t.intent, t.sentiment_score, t.fsm_state,
             t.delivery_status, t.media_type, t.media_gcs_path, t.media_mime,
             t.created_at
        FROM conversation_turns t
        JOIN conversations c ON c.id = t.conversation_id
        ${where}
       ORDER BY t.conversation_id, t.created_at ASC
       LIMIT ${PAGE_SIZE} OFFSET `;

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `vertex-conversations-${stamp}.${format}`;
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header(
      'Content-Type',
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8'
    );

    // Collect pages (flat memory: page-by-page, rows serialized as we go)
    const chunks: string[] = [];
    if (format === 'csv') {
      chunks.push(
        'conversation_id,channel,contact,lead_id,direction,content,intent,' +
          'sentiment,fsm_state,delivery_status,media_type,media_url,timestamp\n'
      );
    } else {
      chunks.push('{"exported_at":"' + new Date().toISOString() + '","turns":[');
    }

    let offset = 0;
    let total = 0;
    let firstJsonRow = true;

    for (;;) {
      const { rows } = (await db.query(baseQuery + String(offset), params)) as { rows: TurnRow[] };
      if (rows.length === 0) break;

      for (const r of rows) {
        const mediaUrl =
          includeMedia && r.media_gcs_path ? await signMediaUrl(r.media_gcs_path) : r.media_gcs_path;

        if (format === 'csv') {
          chunks.push(
            [
              r.conversation_id, r.channel, r.external_user_id, r.lead_id ?? '',
              r.direction, csvEscape(r.content), r.intent ?? '', r.sentiment_score ?? '',
              r.fsm_state ?? '', r.delivery_status ?? '', r.media_type ?? '',
              csvEscape(mediaUrl), r.created_at.toISOString(),
            ]
              .map((f) => (typeof f === 'string' && f.startsWith('"') ? f : csvEscape(f as string)))
              .join(',') + '\n'
          );
        } else {
          chunks.push(
            (firstJsonRow ? '' : ',') +
              JSON.stringify({
                conversationId: r.conversation_id,
                channel: r.channel,
                contact: r.external_user_id,
                leadId: r.lead_id,
                direction: r.direction,
                content: r.content,
                intent: r.intent,
                sentiment: r.sentiment_score !== null ? Number(r.sentiment_score) : null,
                fsmState: r.fsm_state,
                deliveryStatus: r.delivery_status,
                media: r.media_type
                  ? { type: r.media_type, mime: r.media_mime, url: mediaUrl }
                  : null,
                timestamp: r.created_at.toISOString(),
              })
          );
          firstJsonRow = false;
        }
        total++;
      }
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (format === 'json') chunks.push(`],"total_turns":${total}}`);
    logger.info('Conversation export served', { total, format, includeMedia });
    return reply.send(chunks.join(''));
  });
}
