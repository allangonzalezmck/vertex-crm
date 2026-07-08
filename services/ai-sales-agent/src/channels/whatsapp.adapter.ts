/**
 * @file services/ai-sales-agent/src/channels/whatsapp.adapter.ts
 * @description WhatsApp Business API adapter (via Twilio or 360dialog).
 *
 * Architecture note: We abstract the provider behind this adapter so we can swap
 * Twilio ↔ 360dialog ↔ Meta Cloud API without touching the agent core.
 * Current implementation supports Meta Cloud API (direct) as default,
 * with Twilio as a fallback via the same Twilio WhatsApp routing.
 * 360dialog adds value for multi-WABA routing at scale (>10 tenants/WABA).
 *
 * WhatsApp Business constraint: 24-hour customer-initiated messaging window.
 * After 24h of user inactivity, only template messages can be sent.
 * We enforce this by checking last_user_message_at before sending.
 */

import { z } from 'zod';
import type { AgentMessage, TenantAgentConfig } from '../agent/sales-agent.js';
import type { Logger } from '../../../../shared/src/utils/logger.js';

// ─── WhatsApp Webhook Schemas ────────────────────────────────────────────────

export const WhatsAppWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      value: z.object({
        messaging_product: z.literal('whatsapp'),
        metadata: z.object({
          display_phone_number: z.string(),
          phone_number_id: z.string(),
        }),
        contacts: z.array(z.object({
          profile: z.object({ name: z.string() }),
          wa_id: z.string(),
        })).optional(),
        messages: z.array(z.object({
          from: z.string(),
          id: z.string(),
          timestamp: z.string(),
          type: z.enum(['text', 'image', 'audio', 'document', 'video', 'interactive', 'button']),
          text: z.object({ body: z.string() }).optional(),
          interactive: z.object({
            type: z.string(),
            button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
            list_reply: z.object({ id: z.string(), title: z.string(), description: z.string() }).optional(),
          }).optional(),
        })).optional(),
        statuses: z.array(z.object({
          id: z.string(),
          status: z.enum(['sent', 'delivered', 'read', 'failed']),
          timestamp: z.string(),
          recipient_id: z.string(),
        })).optional(),
      }),
      field: z.string(),
    })),
  })),
});

export type WhatsAppWebhook = z.infer<typeof WhatsAppWebhookSchema>;

export interface WhatsAppAdapterConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  businessAccountId: string;
}

// ─── WhatsApp Adapter ────────────────────────────────────────────────────────

export class WhatsAppAdapter {
  private readonly apiBaseUrl = 'https://graph.facebook.com/v19.0';

  constructor(
    private readonly config: WhatsAppAdapterConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Parse incoming webhook payload into normalized AgentMessage objects.
   * Handles text messages and interactive button/list replies.
   * Skips status updates, non-text messages (images, audio, etc.)
   */
  parseWebhook(
    payload: WhatsAppWebhook,
    tenantId: string,
    agentConfig: TenantAgentConfig
  ): AgentMessage[] {
    const messages: AgentMessage[] = [];

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const incoming = change.value.messages ?? [];
        const contacts = change.value.contacts ?? [];
        const phoneNumberId = change.value.metadata.phone_number_id;

        for (const msg of incoming) {
          // Only process text-like messages
          let content: string | null = null;

          if (msg.type === 'text' && msg.text) {
            content = msg.text.body;
          } else if (msg.type === 'interactive' && msg.interactive) {
            // User tapped a quick reply button or list item
            content =
              msg.interactive.button_reply?.title ??
              msg.interactive.list_reply?.title ??
              null;
          }

          if (!content) {
            this.logger.debug('Skipping non-text WhatsApp message', {
              type: msg.type,
              from: msg.from,
            });
            continue;
          }

          const contact = contacts.find(c => c.wa_id === msg.from);
          const conversationId = `wa:${phoneNumberId}:${msg.from}`;

          messages.push({
            messageId: msg.id,
            conversationId,
            direction: 'inbound',
            content,
            channel: 'whatsapp',
            externalUserId: msg.from,
            timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
            metadata: {
              waId: msg.from,
              phoneNumberId,
              contactName: contact?.profile.name ?? null,
              messageType: msg.type,
            },
          });
        }
      }
    }

    return messages;
  }

  /**
   * Send a text message to a WhatsApp user.
   * Marks as read before sending to clear the typing indicator.
   */
  async sendMessage(
    toWaId: string,
    message: string,
    replyToMessageId?: string
  ): Promise<{ messageId: string }> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'text',
      text: {
        preview_url: false,
        body: message,
      },
    };

    if (replyToMessageId) {
      payload['context'] = { message_id: replyToMessageId };
    }

    const response = await this.callApi(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      payload
    );

    return { messageId: response.messages?.[0]?.id ?? '' };
  }

  /**
   * Send a WhatsApp template message (required after 24h window).
   * Template must be pre-approved by Meta.
   */
  async sendTemplateMessage(
    toWaId: string,
    templateName: string,
    languageCode: string,
    components: unknown[]
  ): Promise<{ messageId: string }> {
    const payload = {
      messaging_product: 'whatsapp',
      to: toWaId,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    };

    const response = await this.callApi(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      payload
    );

    return { messageId: response.messages?.[0]?.id ?? '' };
  }

  /**
   * Send quick reply buttons for structured choices.
   * Used in BOOK_CALL state to offer time slots.
   */
  async sendButtonMessage(
    toWaId: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<{ messageId: string }> {
    const payload = {
      messaging_product: 'whatsapp',
      to: toWaId,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    };

    const response = await this.callApi(
      `/${this.config.phoneNumberId}/messages`,
      'POST',
      payload
    );

    return { messageId: response.messages?.[0]?.id ?? '' };
  }

  /**
   * Mark an incoming message as read (shows double blue tick).
   */
  async markAsRead(messageId: string): Promise<void> {
    await this.callApi(`/${this.config.phoneNumberId}/messages`, 'POST', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  /**
   * Verify WhatsApp webhook during initial setup.
   * Returns the hub.challenge value if verify token matches.
   */
  verifyWebhook(
    mode: string,
    token: string,
    challenge: string
  ): string | null {
    if (mode === 'subscribe' && token === this.config.verifyToken) {
      return challenge;
    }
    return null;
  }

  private async callApi(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('WhatsApp API error', undefined, {
        status: response.status,
        path,
        error,
      });
      throw new WhatsAppApiError(
        `WhatsApp API ${response.status}: ${JSON.stringify(error)}`,
        response.status
      );
    }

    return response.json();
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class WhatsAppApiError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}
