/**
 * @file services/notification-service/src/app.ts
 * @description Notification Service — dispatches email (SendGrid), SMS (Twilio),
 * and in-app push notifications. Receives events via Pub/Sub push from
 * workflow-engine and ai-agent services.
 */

import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { createLogger } from '@vertex/shared/utils/logger';
import { getTenantClient, createPool, buildDatabaseConfig } from '@vertex/shared/utils/database';
import type { TenantId } from '@vertex/shared/types';


const logger = createLogger('notification-service');

// ─── Types ────────────────────────────────────────────────────────────────────

type NotificationChannel = 'email' | 'sms' | 'push' | 'in_app';

interface NotificationPayload {
  channel: NotificationChannel;
  tenantId: TenantId;
  to: string; // email address, phone number, or userId
  templateId?: string;
  subject?: string;
  body: string;
  variables?: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

// ─── SendGrid Email Dispatcher ────────────────────────────────────────────────

async function sendEmail(payload: NotificationPayload, apiKey: string): Promise<void> {
  const { to, subject, body, templateId, variables } = payload;

  const sgPayload = templateId
    ? {
        personalizations: [{ to: [{ email: to }], dynamic_template_data: variables ?? {} }],
        from: { email: process.env.FROM_EMAIL ?? 'noreply@vertexcrm.io', name: 'Vertex CRM' },
        template_id: templateId,
      }
    : {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.FROM_EMAIL ?? 'noreply@vertexcrm.io', name: 'Vertex CRM' },
        subject: subject ?? 'Notification from Vertex CRM',
        content: [{ type: 'text/html', value: body }],
      };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(sgPayload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SendGrid error ${res.status}: ${text}`);
  }
}

// ─── Twilio SMS Dispatcher ────────────────────────────────────────────────────

async function sendSms(payload: NotificationPayload, accountSid: string, authToken: string): Promise<void> {
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!fromNumber) throw new Error('TWILIO_FROM_NUMBER not configured');

  const params = new URLSearchParams({
    To: payload.to,
    From: fromNumber,
    Body: payload.body,
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    }
  );

  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`Twilio error ${res.status}: ${(json as any).message ?? 'Unknown'}`);
  }
}

// ─── In-App Notification ──────────────────────────────────────────────────────

async function createInAppNotification(
  payload: NotificationPayload,
  db: Awaited<ReturnType<typeof getTenantClient>>
): Promise<void> {
  await db.query(
    `INSERT INTO notifications (user_id, title, body, entity_type, entity_id, metadata, is_read)
     VALUES ($1, $2, $3, $4, $5, $6, false)`,
    [
      payload.to, // userId for in-app
      payload.subject ?? 'New Notification',
      payload.body,
      payload.entityType ?? null,
      payload.entityId ?? null,
      JSON.stringify(payload.metadata ?? {}),
    ]
  );
}

// ─── Credential Resolver ──────────────────────────────────────────────────────

interface TenantNotificationConfig {
  sendgridApiKey?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  fromEmail?: string;
  fromName?: string;
}

async function getTenantConfig(
  tenantId: TenantId,
  db: Awaited<ReturnType<typeof getTenantClient>>
): Promise<TenantNotificationConfig> {
  // Try tenant-specific config first, fall back to platform keys
  const result = await db.query(
    `SELECT config FROM connector_configs WHERE type = 'notification' LIMIT 1`
  );

  const tenantConfig = result.rows[0]?.config ?? {};

  return {
    sendgridApiKey: tenantConfig.sendgrid_api_key ?? process.env.SENDGRID_API_KEY,
    twilioAccountSid: tenantConfig.twilio_account_sid ?? process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: tenantConfig.twilio_auth_token ?? process.env.TWILIO_AUTH_TOKEN,
    fromEmail: tenantConfig.from_email ?? process.env.FROM_EMAIL,
    fromName: tenantConfig.from_name ?? 'Vertex CRM',
  };
}

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  const db = await getTenantClient(payload.tenantId);

  try {
    const config = await getTenantConfig(payload.tenantId, db);

    // Record notification attempt
    const notifResult = await db.query(
      `INSERT INTO notification_log (tenant_id, channel, recipient, template_id, status, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [payload.tenantId, payload.channel, payload.to, payload.templateId ?? null, JSON.stringify(payload.metadata ?? {})]
    );
    const logId = notifResult.rows[0]?.id;

    try {
      switch (payload.channel) {
        case 'email': {
          if (!config.sendgridApiKey) throw new Error('SendGrid not configured');
          await sendEmail(payload, config.sendgridApiKey);
          break;
        }
        case 'sms': {
          if (!config.twilioAccountSid || !config.twilioAuthToken) {
            throw new Error('Twilio not configured');
          }
          await sendSms(payload, config.twilioAccountSid, config.twilioAuthToken);
          break;
        }
        case 'in_app':
        case 'push': {
          await createInAppNotification(payload, db);
          break;
        }
        default:
          throw new Error(`Unknown channel: ${payload.channel}`);
      }

      // Mark success
      if (logId) {
        await db.query(
          `UPDATE notification_log SET status = 'sent', sent_at = NOW() WHERE id = $1`,
          [logId]
        );
      }

      logger.info('Notification sent', { channel: payload.channel, tenantId: payload.tenantId });
    } catch (err) {
      if (logId) {
        await db.query(
          `UPDATE notification_log SET status = 'failed', error = $1 WHERE id = $2`,
          [(err as Error).message, logId]
        );
      }
      throw err;
    }
  } finally {
    await (db as any).release?.();
  }
}

// ─── Pub/Sub Event Router ─────────────────────────────────────────────────────

async function routeEvent(
  eventType: string,
  tenantId: TenantId,
  payload: Record<string, unknown>
): Promise<void> {
  switch (eventType) {
    case 'workflow.send_email': {
      await dispatchNotification({
        channel: 'email',
        tenantId,
        to: payload.to as string,
        templateId: payload.templateId as string | undefined,
        body: payload.body as string ?? '',
        variables: payload.variables as Record<string, unknown>,
      });
      break;
    }

    case 'workflow.notification': {
      await dispatchNotification({
        channel: 'in_app',
        tenantId,
        to: payload.userId as string,
        subject: payload.title as string,
        body: payload.body as string,
        entityType: payload.entityType as string | undefined,
        entityId: payload.entityId as string | undefined,
      });
      break;
    }

    case 'ai_agent.booking_confirmed': {
      // Lead booked a call — notify assigned rep
      await dispatchNotification({
        channel: 'in_app',
        tenantId,
        to: payload.assignedToId as string,
        subject: '📅 New meeting booked',
        body: `${payload.leadName ?? 'A lead'} booked a call for ${payload.scheduledAt}`,
        entityType: 'lead',
        entityId: payload.leadId as string,
      });
      break;
    }

    case 'ai_agent.lead_handoff': {
      // AI agent handed off to sales rep
      await dispatchNotification({
        channel: 'in_app',
        tenantId,
        to: payload.assignedToId as string,
        subject: '🤖 AI Agent handoff',
        body: `${payload.leadName ?? 'A lead'} requested to speak with someone`,
        entityType: 'lead',
        entityId: payload.leadId as string,
      });
      break;
    }

    default:
      logger.debug('Unhandled notification event type', { eventType });
  }
}

// ─── Fastify App ──────────────────────────────────────────────────────────────

const app = Fastify({ logger: false, genReqId: () => `notif-${Date.now()}` });

app.register(helmet, { contentSecurityPolicy: false });

app.get('/health', async () => ({ status: 'ok', service: 'notification-service' }));
app.get('/ready', async () => ({ status: 'ready' }));

// Pub/Sub push endpoint
app.post('/pubsub', async (request, reply) => {
  const body = request.body as any;

  if (!body?.message?.data) {
    return reply.code(200).send();
  }

  let event: { type: string; tenantId: TenantId; payload: Record<string, unknown> };
  try {
    const decoded = Buffer.from(body.message.data, 'base64').toString('utf8');
    event = JSON.parse(decoded);
  } catch {
    return reply.code(200).send();
  }

  try {
    await routeEvent(event.type, event.tenantId, event.payload);
  } catch (err) {
    logger.error('Notification dispatch failed', { err, eventType: event.type, tenantId: event.tenantId });
    // Return 500 to trigger Pub/Sub retry via DLQ
    return reply.code(500).send({ error: 'Dispatch failed' });
  }

  return reply.code(200).send({ dispatched: true });
});

// Direct dispatch (internal/admin)
app.post('/send', async (request, reply) => {
  const payload = request.body as NotificationPayload;
  await dispatchNotification(payload);
  return reply.send({ sent: true });
});

// Notification inbox for a user
app.get('/inbox/:userId', async (request: any, reply) => {
  const { tenantId } = request.headers;
  if (!tenantId) return reply.code(400).send({ error: 'Missing tenant-id header' });

  const db = await getTenantClient(tenantId as TenantId);
  try {
    const result = await db.query(
      `SELECT id, title, body, entity_type, entity_id, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [request.params.userId]
    );
    return reply.send({ data: result.rows });
  } finally {
    await (db as any).release?.();
  }
});

// Mark notification read
app.patch('/inbox/:notifId/read', async (request: any, reply) => {
  const { tenantId } = request.headers;
  if (!tenantId) return reply.code(400).send({ error: 'Missing tenant-id header' });

  const db = await getTenantClient(tenantId as TenantId);
  try {
    await db.query(
      `UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1`,
      [request.params.notifId]
    );
    return reply.send({ updated: true });
  } finally {
    await (db as any).release?.();
  }
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const start = async () => {
  try {
    const port = parseInt(process.env.PORT ?? '8080', 10);
    createPool(buildDatabaseConfig());
    await app.listen({ port, host: '0.0.0.0' });
    logger.info('Notification service started', { port });
  } catch (err) {
    logger.error('Failed to start notification service', { err });
    process.exit(1);
  }
};

start();

export { app };
