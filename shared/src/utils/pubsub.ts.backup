/**
 * @file shared/src/utils/pubsub.ts
 * @description Type-safe Pub/Sub publisher and subscriber utilities.
 * All events use the PubSubEnvelope wrapper for versioning and deduplication.
 * Subscriber handlers must be idempotent (at-least-once delivery guaranteed).
 */

import { PubSub, type Message, type Subscription, type Topic } from '@google-cloud/pubsub';
import { randomUUID } from 'crypto';
import type { PubSubEnvelope, TenantId } from '../types/index.js';
import type { Logger } from './logger.js';

let pubsubClient: PubSub | null = null;

export function getPubSubClient(): PubSub {
  if (!pubsubClient) {
    pubsubClient = new PubSub({
      projectId: process.env['GOOGLE_CLOUD_PROJECT'],
      // Workload Identity handles auth in Cloud Run — no key file needed
    });
  }
  return pubsubClient;
}

// Cache topic references to avoid repeated API calls
const topicCache = new Map<string, Topic>();

async function getTopic(topicName: string): Promise<Topic> {
  if (topicCache.has(topicName)) {
    return topicCache.get(topicName)!;
  }

  const client = getPubSubClient();
  const topic = client.topic(topicName, {
    batching: {
      maxMessages: 100,
      maxMilliseconds: 500, // flush within 500ms
    },
    flowControl: {
      maxOutstandingMessages: 1000,
    },
  });

  topicCache.set(topicName, topic);
  return topic;
}

/**
 * Publish a typed event to a Pub/Sub topic.
 * Returns the message ID for idempotency tracking.
 */
export async function publishEvent<T>(
  topicName: string,
  eventType: string,
  tenantId: TenantId,
  payload: T,
  logger?: Logger
): Promise<string> {
  const envelope: PubSubEnvelope<T> = {
    eventType,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    tenantId,
    payload,
    version: '1.0',
  };

  const topic = await getTopic(topicName);
  const messageBuffer = Buffer.from(JSON.stringify(envelope));

  try {
    const messageId = await topic.publishMessage({
      data: messageBuffer,
      attributes: {
        eventType,
        tenantId,
        eventId: envelope.eventId,
        version: '1.0',
      },
    });

    logger?.info('Event published', {
      topicName,
      eventType,
      eventId: envelope.eventId,
      messageId,
      tenantId,
    });

    return messageId;
  } catch (err) {
    logger?.error('Failed to publish event', err, {
      topicName,
      eventType,
      tenantId,
    });
    throw new PubSubError(`Failed to publish to ${topicName}`, err);
  }
}

/**
 * Subscribe to a Pub/Sub topic with automatic message acknowledgment.
 * Handler must be idempotent — Pub/Sub guarantees at-least-once delivery.
 * On handler error, message is nack'd and retried per subscription config.
 */
export function subscribeToTopic<T>(
  subscriptionName: string,
  handler: (envelope: PubSubEnvelope<T>, rawMessage: Message) => Promise<void>,
  options: {
    maxConcurrent?: number;
    logger?: Logger;
  } = {}
): Subscription {
  const client = getPubSubClient();
  const subscription = client.subscription(subscriptionName, {
    flowControl: {
      maxMessages: options.maxConcurrent ?? 10,
    },
  });

  subscription.on('message', async (message: Message) => {
    const { logger } = options;
    let envelope: PubSubEnvelope<T>;

    try {
      const data = message.data.toString('utf-8');
      envelope = JSON.parse(data) as PubSubEnvelope<T>;
    } catch (err) {
      logger?.error('Failed to parse Pub/Sub message', err, {
        subscriptionName,
        messageId: message.id,
      });
      // Ack malformed messages to prevent infinite redelivery
      message.ack();
      return;
    }

    logger?.info('Processing Pub/Sub message', {
      subscriptionName,
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      messageId: message.id,
      tenantId: envelope.tenantId,
      deliveryAttempt: message.deliveryAttempt,
    });

    try {
      await handler(envelope, message);
      message.ack();
      logger?.info('Message processed successfully', {
        subscriptionName,
        eventId: envelope.eventId,
        messageId: message.id,
      });
    } catch (err) {
      logger?.error('Message handler failed', err, {
        subscriptionName,
        eventId: envelope.eventId,
        messageId: message.id,
        deliveryAttempt: message.deliveryAttempt,
      });
      // nack causes redelivery with backoff
      message.nack();
    }
  });

  subscription.on('error', (err: Error) => {
    options.logger?.error('Subscription error', err, { subscriptionName });
  });

  options.logger?.info('Subscription active', { subscriptionName });
  return subscription;
}

/**
 * Redis-based idempotency check for message deduplication.
 * Use when exactly-once processing is required.
 */
export async function isMessageProcessed(
  redisClient: { get: (key: string) => Promise<string | null>; setex: (key: string, ttl: number, value: string) => Promise<unknown> },
  eventId: string,
  ttlSeconds: number = 86400 // 24 hours
): Promise<boolean> {
  const key = `pubsub:processed:${eventId}`;
  const existing = await redisClient.get(key);

  if (existing) return true;

  await redisClient.setex(key, ttlSeconds, '1');
  return false;
}

export const TOPICS = {
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  DEAL_STAGE_CHANGED: 'deal.stage.changed',
  MARKETING_INGESTION_TRIGGER: 'marketing.ingestion.trigger',
  MARKETING_METRICS_INGESTED: 'marketing.metrics.ingested',
  CONVERSATION_TURN: 'conversation.turn',
  CONVERSATION_ENDED: 'conversation.ended',
  CONVERSATION_HANDOFF: 'conversation.handoff',
  WORKFLOW_TRIGGERED: 'workflow.triggered',
  EMAIL_SEND: 'email.send',
  AUDIT_EVENT: 'audit.event',
  BILLING_SUBSCRIPTION_UPDATED: 'billing.subscription.updated',
  // ── Added in peer-review: topics referenced by services but previously
  //    missing from this map (publishEvent would receive `undefined`) ──
  BILLING_PLAN_CHANGED: 'billing.plan.changed',
  BILLING_LIMIT_WARNING: 'billing.limit.warning',
  CONVERSATION_HANDOFF_REQUESTED: 'conversation.handoff.requested',
  CRM_EVENTS: 'crm.events',
  KB_DOCUMENT_READY: 'kb.document.ready',
  NOTIFICATIONS: 'notifications.dispatch',
} as const;

export class PubSubError extends Error {
  public readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PubSubError';
    this.cause = cause;
  }
}
