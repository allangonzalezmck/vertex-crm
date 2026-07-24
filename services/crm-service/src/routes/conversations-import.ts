/**
 * Vertex CRM — WhatsApp History Import Routes (GAP-05)
 *
 * Two-step flow so tenants never commit garbage:
 *   POST /api/v1/conversations/import/preview
 *     body: { filename, text, tenantPhoneLabel?, dateOrderHint? }
 *     → parse summary + first 5 messages for visual confirmation. Nothing written.
 *   POST /api/v1/conversations/import/commit
 *     body: preview body + { contactPhone?, leadId? }
 *     → archives the original file to GCS, creates an import batch, inserts
 *       one conversation (source='import') + all turns with ORIGINAL timestamps.
 *   DELETE /api/v1/conversations/import/:batchId
 *     → undo: removes the batch's conversation and turns (original file stays archived).
 *
 * Direction mapping: the export contains two+ participants; the tenant tells
 * us which sender label is THEIR side (tenantPhoneLabel). That side becomes
 * 'outbound'; everyone else 'inbound'. If omitted, the first sender is
 * assumed to be the contact (inbound) — shown in the preview so the tenant
 * can correct before committing.
 *
 * All queries run on the request's RLS-scoped client (request.db) — imports
 * are tenant-isolated by the database, like everything else.
 *
 * File location: services/crm-service/src/routes/conversations-import.ts
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { Storage } from '@google-cloud/storage';
import { z } from 'zod';
import { createLogger } from '@vertex/shared/utils/logger';
import { parseWhatsAppExport } from '../services/whatsapp-import.parser.js';

const logger = createLogger('conversations-import');
const storage = new Storage();

const MAX_TEXT_BYTES = 15 * 1024 * 1024; // generous; a year of heavy chat is ~2–3 MB

const PreviewSchema = z.object({
  filename: z.string().min(1).max(255),
  text: z.string().min(1),
  tenantPhoneLabel: z.string().max(120).optional(),
  dateOrderHint: z.enum(['DMY', 'MDY']).default('DMY'),
});

const CommitSchema = PreviewSchema.extend({
  contactPhone: z.string().max(32).optional(),
  leadId: z.string().uuid().optional(),
});

function bucketName(): string {
  return process.env['WHATSAPP_MEDIA_BUCKET'] ??
    `${process.env['GCP_PROJECT_ID']}-whatsapp-media`;
}

export async function conversationsImportRouter(app: FastifyInstance): Promise<void> {
  app.post('/import/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = PreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'INVALID_BODY', details: parsed.error.flatten().fieldErrors } });
    }
    const { text, tenantPhoneLabel, dateOrderHint } = parsed.data;
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      return reply.status(413).send({ success: false, error: { code: 'FILE_TOO_LARGE', message: 'Export exceeds 15 MB. Split the export or contact support.' } });
    }

    const result = parseWhatsAppExport(text, dateOrderHint);
    if (result.messages.length === 0) {
      return reply.status(422).send({
        success: false,
        error: {
          code: 'UNRECOGNIZED_FORMAT',
          message: 'No messages recognized. Confirm this is an unmodified WhatsApp "Export chat" .txt file.',
          unparsedLines: result.unparsedLines,
        },
      });
    }

    const outboundLabel = tenantPhoneLabel ?? null;
    return reply.send({
      success: true,
      data: {
        totalMessages: result.messages.length,
        participants: result.participants,
        assumedOutboundParticipant: outboundLabel ?? result.participants[1] ?? null,
        dateOrderDetected: result.dateOrder,
        firstMessageAt: result.firstMessageAt,
        lastMessageAt: result.lastMessageAt,
        mediaMessages: result.messages.filter((m) => m.isMedia).length,
        systemLinesExcluded: result.systemLines,
        unparsedLines: result.unparsedLines,
        sample: result.messages.slice(0, 5).map((m) => ({
          at: m.timestamp, sender: m.sender,
          content: m.content.slice(0, 140), isMedia: m.isMedia,
        })),
      },
    });
  });

  app.post('/import/commit', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CommitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'INVALID_BODY', details: parsed.error.flatten().fieldErrors } });
    }
    const { filename, text, tenantPhoneLabel, dateOrderHint, contactPhone, leadId } = parsed.data;
    const { db, tenantId } = request as unknown as { db: { query: Function }; tenantId: string };

    const result = parseWhatsAppExport(text, dateOrderHint);
    if (result.messages.length === 0) {
      return reply.status(422).send({ success: false, error: { code: 'UNRECOGNIZED_FORMAT', message: 'No messages recognized.' } });
    }

    const batchId = randomUUID();
    const conversationId = `import:${batchId}`;

    // 1. Archive the ORIGINAL file first — even a later bug can't lose data
    const objectPath = `chat-imports/${tenantId}/${batchId}/${filename}`;
    await storage.bucket(bucketName()).file(objectPath).save(Buffer.from(text, 'utf8'), {
      contentType: 'text/plain; charset=utf-8', resumable: false,
    });
    const gcsPath = `gs://${bucketName()}/${objectPath}`;

    // Outbound side: explicit label, else "everyone but the first sender"
    const outboundLabel = tenantPhoneLabel ?? null;
    const inferredContact = result.participants[0] ?? 'Unknown';
    const isOutbound = (sender: string) =>
      outboundLabel !== null ? sender === outboundLabel : sender !== inferredContact;
    const contactLabel = outboundLabel
      ? result.participants.find((p) => p !== outboundLabel) ?? inferredContact
      : inferredContact;

    // 2. Batch record → conversation → turns (original timestamps preserved)
    await db.query(
      `INSERT INTO chat_import_batches
         (id, tenant_id, filename, gcs_path, message_count, participants, date_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [batchId, tenantId, filename, gcsPath, result.messages.length,
       JSON.stringify(result.participants), result.dateOrder]
    );
    await db.query(
      `INSERT INTO conversations
         (id, tenant_id, channel, external_user_id, lead_id, state, source, created_at)
       VALUES ($1, $2, 'whatsapp', $3, $4, 'IMPORTED', 'import', $5)`,
      [conversationId, tenantId, contactPhone ?? contactLabel, leadId ?? null,
       result.firstMessageAt]
    );

    const BATCH = 500;
    for (let i = 0; i < result.messages.length; i += BATCH) {
      const slice = result.messages.slice(i, i + BATCH);
      const values: string[] = [];
      const params: unknown[] = [];
      slice.forEach((m, j) => {
        const base = j * 6;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        params.push(
          randomUUID(), conversationId, tenantId,
          isOutbound(m.sender) ? 'outbound' : 'inbound',
          m.content, m.timestamp
        );
      });
      await db.query(
        `INSERT INTO conversation_turns
           (id, conversation_id, tenant_id, direction, content, created_at)
         VALUES ${values.join(', ')}`,
        params
      );
    }

    logger.info('Chat import committed', { batchId, messages: result.messages.length });
    return reply.send({
      success: true,
      data: {
        batchId, conversationId,
        imported: result.messages.length,
        contact: contactPhone ?? contactLabel,
        archivedOriginal: gcsPath,
      },
    });
  });

  app.delete<{ Params: { batchId: string } }>(
    '/import/:batchId',
    async (request, reply) => {
      const { db } = request as unknown as { db: { query: Function } };
      const { batchId } = request.params;
      if (!z.string().uuid().safeParse(batchId).success) {
        return reply.status(400).send({ success: false, error: { code: 'INVALID_BATCH_ID' } });
      }
      // Turns cascade via the conversation FK; original file stays archived in GCS
      const res = await db.query(`DELETE FROM conversations WHERE id = $1 AND source = 'import'`, [`import:${batchId}`]);
      await db.query(`DELETE FROM chat_import_batches WHERE id = $1`, [batchId]);
      return reply.send({ success: true, data: { removedConversations: res.rowCount ?? 0 } });
    }
  );
}
