/**
 * @file services/ai-sales-agent/src/app.ts
 * @description AI Sales Agent service bootstrap.
 * Routes inbound webhooks from all channels → SalesAgent → channel-specific reply.
 */

import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import Redis from 'ioredis';
import { createLogger } from '../../../shared/src/utils/logger.js';
import { createSuccessResponse, createErrorResponse } from '../../../shared/src/schemas/index.js';
import { SalesAgent } from './agent/sales-agent.js';
import { WhatsAppAdapter, WhatsAppWebhookSchema } from './channels/whatsapp.adapter.js';
import { CalBookingService } from './booking/cal-booking.service.js';
import { getTenantClient } from '../../../shared/src/utils/database.js';
import { Pool } from 'pg';
import { WhatsAppMediaArchiver } from './channels/whatsapp-media-archiver.js';
import { WhatsAppQualityMonitor } from './channels/whatsapp-quality-monitor.js';

const servicePool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const qualityMonitor = new WhatsAppQualityMonitor(servicePool);
import type { TenantAgentConfig } from './agent/sales-agent.js';
import type { TenantId } from '../../../shared/src/types/index.js';

const logger = createLogger('ai-sales-agent');

const PROJECT_ID = process.env['GCP_PROJECT_ID'] ?? '';
const LOCATION = process.env['GCP_LOCATION'] ?? 'us-central1';

// ─── Agent Config Cache ───────────────────────────────────────────────────────

const agentConfigCache = new Map<string, { config: TenantAgentConfig; expiresAt: number }>();

async function getAgentConfig(tenantId: TenantId): Promise<TenantAgentConfig | null> {
  const cached = agentConfigCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const client = await getTenantClient(tenantId);
  try {
    const result = await client.query<TenantAgentConfig>(
      `SELECT
         tenant_id,
         agent_name,
         agent_persona,
         business_name,
         deal_value_threshold,
         calendar_link,
         human_handoff_email,
         language_code
       FROM tenant_agent_configs
       WHERE tenant_id = $1 AND is_active = true
       LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length === 0) return null;

    const config = result.rows[0]!;
    agentConfigCache.set(tenantId, {
      config,
      expiresAt: Date.now() + 5 * 60 * 1000, // Cache 5 minutes
    });

    return config;
  } finally {
    client.release();
  }
}

// ─── App Builder ──────────────────────────────────────────────────────────────

export async function buildApp() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  const redis = new Redis({
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379'),
    password: process.env['REDIS_PASSWORD'],
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  const salesAgent = new SalesAgent(PROJECT_ID, LOCATION, redis, logger);
  const calBooking = new CalBookingService(logger);

  // ─── Health ─────────────────────────────────────────────────────────────

  /** GAP-03: daily quality poll across active WhatsApp channels (Cloud Scheduler). */
  app.post('/internal/quality-sweep', async () => {
    const { rows } = await servicePool.query(
      `SELECT tenant_id, config_plain FROM channel_configs
        WHERE channel = 'whatsapp' AND is_active = true AND config_plain IS NOT NULL`
    );
    let polled = 0;
    for (const r of rows) {
      const cfg = r.config_plain as { phoneNumberId?: string; accessToken?: string };
      if (cfg.phoneNumberId && cfg.accessToken) {
        await qualityMonitor.pollQuality(r.tenant_id, cfg.phoneNumberId, cfg.accessToken)
          .catch(() => {});
        polled++;
      }
    }
    return { polled };
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (req, reply) => {
    try {
      await redis.ping();
      reply.send({ status: 'ready' });
    } catch {
      reply.status(503).send({ status: 'not_ready' });
    }
  });

  // ─── WhatsApp Webhook ────────────────────────────────────────────────────

  /** WhatsApp webhook verification (GET) */
  app.get<{ Querystring: Record<string, string> }>(
    '/agent/webhooks/whatsapp',
    async (req, reply) => {
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

      // Verify token is stored per-tenant in practice; using env var for simplicity here
      const verifyToken = process.env['WHATSAPP_VERIFY_TOKEN'] ?? '';
      if (mode === 'subscribe' && token === verifyToken) {
        return reply.status(200).send(challenge);
      }
      return reply.status(403).send('Forbidden');
    }
  );

  /** WhatsApp message webhook (POST) */
  app.post<{ Params: { tenantId: string } }>(
    '/agent/webhooks/whatsapp/:tenantId',
    async (req, reply) => {
      // Respond 200 immediately — WhatsApp requires <5s response time
      // Processing happens synchronously here but would be Pub/Sub in higher-volume setups
      reply.status(200).send({ status: 'ok' });

      const tenantId = req.params.tenantId as TenantId;
      const parsed = WhatsAppWebhookSchema.safeParse(req.body);

      if (!parsed.success) {
        logger.warn('Invalid WhatsApp webhook payload', { errors: parsed.error.errors });
        return;
      }

      const agentConfig = await getAgentConfig(tenantId);
      if (!agentConfig) {
        logger.warn('No agent config for tenant', { tenantId });
        return;
      }

      // Load WhatsApp adapter config from Secret Manager / DB
      const waConfig = await getWhatsAppConfig(tenantId);
      if (!waConfig) return;

      // GAP-03: non-message changes (quality/tier/account events) → monitor
      for (const entry of parsed.data.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'messages') {
            await qualityMonitor
              .handleWebhookChange(tenantId, change as never)
              .catch((err) => logger.warn('Quality monitor error', { err: (err as Error).message }));
          }
        }
      }

      const adapter = new WhatsAppAdapter(waConfig, logger);
      const messages = adapter.parseWebhook(parsed.data, tenantId, agentConfig);

      // GAP-02: archive attachments before Meta's ~30-day deletion
      const archiver = new WhatsAppMediaArchiver(waConfig.accessToken);
      for (const m of messages) {
        if (m.media) {
          const archived = await archiver.archive(m.media, tenantId, m.conversationId);
          if (archived) (m as { archivedMedia?: typeof archived }).archivedMedia = archived;
        }
      }

      for (const message of messages) {
        try {
          // Mark as read immediately (shows typing indicator to user)
          await adapter.markAsRead(message.messageId).catch(() => {});

          const result = await salesAgent.processMessage(message, agentConfig);

          // If booking flow triggered, integrate Cal.com
          if (result.triggerBooking && agentConfig.calendarLink) {
            const slots = await calBooking.getAvailableSlots(agentConfig.calendarLink);
            if (slots.length >= 2) {
              // Send button message with 2 time slot options
              const slotButtons = slots.slice(0, 2).map((slot, i) => ({
                id: `slot_${i}`,
                title: calBooking.formatSlot(slot),
              }));

              await adapter.sendButtonMessage(
                message.externalUserId,
                result.outboundMessage,
                slotButtons
              );
            } else {
              await adapter.sendMessage(message.externalUserId, result.outboundMessage);
            }
          } else {
            await adapter.sendMessage(
              message.externalUserId,
              result.outboundMessage,
              message.messageId
            );
          }

          logger.info('WhatsApp turn processed', {
            tenantId,
            conversationId: result.conversationId,
            state: result.state,
            triggerHandoff: result.triggerHandoff,
          });
        } catch (err) {
          logger.error('WhatsApp message processing error', err, {
            conversationId: message.conversationId,
            tenantId,
          });
        }
      }
    }
  );

  // ─── Facebook Messenger Webhook ───────────────────────────────────────────

  app.get<{ Querystring: Record<string, string> }>(
    '/agent/webhooks/facebook',
    async (req, reply) => {
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
      const verifyToken = process.env['FACEBOOK_VERIFY_TOKEN'] ?? '';
      if (mode === 'subscribe' && token === verifyToken) {
        return reply.status(200).send(challenge);
      }
      return reply.status(403).send('Forbidden');
    }
  );

  app.post<{ Params: { tenantId: string } }>(
    '/agent/webhooks/facebook/:tenantId',
    async (req, reply) => {
      reply.status(200).send({ status: 'ok' });

      const tenantId = req.params.tenantId as TenantId;
      const body = req.body as {
        object?: string;
        entry?: Array<{
          messaging?: Array<{
            sender: { id: string };
            recipient: { id: string };
            timestamp: number;
            message?: { mid: string; text: string };
          }>;
        }>;
      };

      if (body.object !== 'page') return;

      const agentConfig = await getAgentConfig(tenantId);
      if (!agentConfig) return;

      for (const entry of body.entry ?? []) {
        for (const messagingEvent of entry.messaging ?? []) {
          if (!messagingEvent.message?.text) continue;

          const conversationId = `fb:${messagingEvent.recipient.id}:${messagingEvent.sender.id}`;
          const agentMessage = {
            messageId: messagingEvent.message.mid,
            conversationId,
            direction: 'inbound' as const,
            content: messagingEvent.message.text,
            channel: 'facebook' as const,
            externalUserId: messagingEvent.sender.id,
            timestamp: new Date(messagingEvent.timestamp).toISOString(),
            metadata: {},
          };

          try {
            const result = await salesAgent.processMessage(agentMessage, agentConfig);
            await sendFacebookMessage(tenantId, messagingEvent.sender.id, result.outboundMessage);
          } catch (err) {
            logger.error('Facebook message processing error', err, { tenantId, conversationId });
          }
        }
      }
    }
  );

  // ─── Cal.com Booking Webhook ──────────────────────────────────────────────

  app.post<{ Params: { tenantId: string } }>(
    '/agent/webhooks/cal/:tenantId',
    async (req, reply) => {
      const tenantId = req.params.tenantId as TenantId;
      const event = req.body as {
        triggerEvent: string;
        payload: {
          uid: string;
          startTime: string;
          attendees: Array<{ email: string; name: string }>;
          organizer: { email: string };
        };
      };

      logger.info('Cal.com webhook received', {
        tenantId,
        event: event.triggerEvent,
        bookingId: event.payload?.uid,
      });

      if (event.triggerEvent === 'BOOKING_CREATED') {
        await calBooking.handleBookingCreated(tenantId, event.payload);
      }

      return reply.status(200).send({ status: 'ok' });
    }
  );

  // ─── Pub/Sub: Handoff Notifications ──────────────────────────────────────

  app.post('/pubsub/handoff', async (req, reply) => {
    const message = (req.body as { message?: { data?: string } })?.message;
    if (!message?.data) return reply.status(200).send();

    try {
      const payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf-8'));
      await processHandoffNotification(payload);
    } catch (err) {
      logger.error('Handoff notification processing failed', err);
    }

    return reply.status(200).send({ status: 'ok' });
  });

  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getWhatsAppConfig(tenantId: TenantId) {
  const client = await getTenantClient(tenantId);
  try {
    const result = await client.query(
      `SELECT config_plain FROM channel_configs
       WHERE tenant_id = $1 AND channel = 'whatsapp' AND is_active = true
       LIMIT 1`,
      [tenantId]
    );
    if (result.rows.length === 0) return null;
    const config = result.rows[0]!['config_plain'] as Record<string, string>;
    return {
      accessToken: config['access_token'] ?? '',
      phoneNumberId: config['phone_number_id'] ?? '',
      verifyToken: config['verify_token'] ?? '',
      businessAccountId: config['business_account_id'] ?? '',
    };
  } finally {
    client.release();
  }
}

async function sendFacebookMessage(
  tenantId: TenantId,
  recipientId: string,
  message: string
): Promise<void> {
  const client = await getTenantClient(tenantId);
  let pageAccessToken = '';
  try {
    const result = await client.query(
      `SELECT config_plain FROM channel_configs
       WHERE tenant_id = $1 AND channel = 'facebook' AND is_active = true LIMIT 1`,
      [tenantId]
    );
    pageAccessToken = result.rows[0]?.['config_plain']?.['page_access_token'] ?? '';
  } finally {
    client.release();
  }

  if (!pageAccessToken) return;

  await fetch('https://graph.facebook.com/v19.0/me/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message },
      messaging_type: 'RESPONSE',
    }),
  });
}

async function processHandoffNotification(payload: {
  tenantId: TenantId;
  conversationId: string;
  humanHandoffEmail: string;
  capturedData: Record<string, unknown>;
  escalationReason: string;
}): Promise<void> {
  logger.info('Processing handoff notification', {
    tenantId: payload.tenantId,
    conversationId: payload.conversationId,
    reason: payload.escalationReason,
  });
  // Email sent via notification-service via Pub/Sub — no direct email here
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (process.env['NODE_ENV'] !== 'test') {
  buildApp().then(app => {
    const port = parseInt(process.env['PORT'] ?? '8080');
    app.listen({ port, host: '0.0.0.0' }, (err) => {
      if (err) {
        logger.error('Failed to start AI Sales Agent service', err);
        process.exit(1);
      }
      logger.info('AI Sales Agent service started', { port });
    });
  });
}
