/**
 * Vertex CRM — WhatsApp Quality Monitor (GAP-03 fix)
 *
 * WHY: Meta silently downgrades WhatsApp numbers whose recipients block or
 * report them (quality GREEN → YELLOW → RED), cuts the messaging tier, and
 * can restrict the number outright. Kommo-style platforms let tenants slide
 * into restriction unnoticed. This module makes degradation loud and early.
 *
 * Two feeds, belt and braces:
 *   1. WEBHOOK (real-time): Meta sends `phone_number_quality_update` and
 *      `account_update` events on the WhatsApp Business Account subscription.
 *      Wire the existing /agent/webhook/whatsapp route to pass any change
 *      whose field !== 'messages' to handleWebhookChange().
 *      (In Meta App Dashboard → WhatsApp → Configuration → Webhook fields:
 *       subscribe to `phone_number_quality_update` and `account_update`.)
 *   2. DAILY POLL (fallback): pollQuality() reads the phone number's current
 *      quality_rating from the Graph API in case a webhook was missed.
 *      Wire to Cloud Scheduler like the GAP-01 token sweep.
 *
 * Every change is persisted to channel_health_events (audit trail, migration
 * 008), reflected on channel_configs, and pushed to the tenant via the
 * notification topic with severity proportional to the damage.
 *
 * File location: services/ai-sales-agent/src/channels/whatsapp-quality-monitor.ts
 */

import { Pool } from 'pg';
import { createLogger, Logger } from '../../../../shared/src/utils/logger.js';
import { publishEvent, TOPICS } from '../../../../shared/src/utils/pubsub.js';

type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

/** Shape of the non-message webhook changes we care about. */
interface QualityWebhookChange {
  field: string;
  value: {
    display_phone_number?: string;
    phone_number?: string;
    event?: string;                       // e.g. 'FLAGGED', 'UNFLAGGED', 'DOWNGRADE', 'UPGRADE'
    current_limit?: string;               // e.g. 'TIER_1K', 'TIER_10K', 'TIER_100K'
    old_limit?: string;
    // account_update payloads
    ban_info?: { waba_ban_state?: string; waba_ban_date?: string };
    restriction_info?: Array<{ restriction_type?: string; expiration?: string }>;
  };
}

const SEVERITY_BY_EVENT: Record<string, 'info' | 'warning' | 'critical'> = {
  UPGRADE: 'info',
  UNFLAGGED: 'info',
  ONBOARDING: 'info',
  DOWNGRADE: 'warning',
  FLAGGED: 'warning',
  RESTRICTED: 'critical',
  DISABLED_UPDATE: 'critical',
};

export class WhatsAppQualityMonitor {
  private readonly logger: Logger;
  private readonly graphBase = 'https://graph.facebook.com/v19.0';

  constructor(private readonly pool: Pool) {
    this.logger = createLogger('whatsapp-quality-monitor');
  }

  /**
   * Entry point for non-message webhook changes. Returns true when the
   * change was a quality/account event (so the caller knows it was consumed).
   */
  async handleWebhookChange(tenantId: string, change: QualityWebhookChange): Promise<boolean> {
    if (change.field !== 'phone_number_quality_update' && change.field !== 'account_update') {
      return false;
    }

    const v = change.value;
    const event =
      v.event ??
      (v.ban_info?.waba_ban_state ? 'DISABLED_UPDATE' : undefined) ??
      (v.restriction_info?.length ? 'RESTRICTED' : 'UNKNOWN');
    const severity = SEVERITY_BY_EVENT[event] ?? 'warning';

    await this.recordEvent(tenantId, change.field, event, v.old_limit ?? null, v.current_limit ?? null, v);

    // Reflect the latest known state on the channel config
    if (v.current_limit || event) {
      await this.pool.query(
        `UPDATE channel_configs
            SET messaging_tier = COALESCE($1, messaging_tier),
                quality_updated_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $2 AND channel = 'whatsapp'`,
        [v.current_limit ?? null, tenantId]
      );
    }

    const tierNote = v.current_limit
      ? ` Messaging tier is now ${v.current_limit}${v.old_limit ? ` (was ${v.old_limit})` : ''}.`
      : '';
    await publishEvent(TOPICS.NOTIFICATIONS, {
      tenantId,
      type: 'whatsapp_quality_event',
      severity,
      title:
        severity === 'critical'
          ? 'WhatsApp number restricted'
          : severity === 'warning'
            ? 'WhatsApp number quality dropped'
            : 'WhatsApp number status update',
      body:
        `Meta reported "${event}" for your WhatsApp number.${tierNote} ` +
        (severity !== 'info'
          ? 'Common causes: messaging users who did not opt in, or template blasts marked as spam. ' +
            'Reduce outbound volume to cold contacts and review recent templates.'
          : ''),
    });

    this.logger.info('Quality event processed', { tenantId, field: change.field, event, severity });
    return true;
  }

  /**
   * Daily fallback poll: reads the current quality rating straight from the
   * Graph API and records a synthetic event when it differs from the last
   * known value. Requires the tenant's WhatsApp access token + phone number id.
   */
  async pollQuality(tenantId: string, phoneNumberId: string, accessToken: string): Promise<QualityRating> {
    const res = await fetch(
      `${this.graphBase}/${phoneNumberId}?fields=quality_rating,display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const json = (await res.json()) as {
      quality_rating?: QualityRating;
      error?: { message: string; code: number };
    };
    if (!res.ok || json.error) {
      this.logger.warn('Quality poll failed', { tenantId, error: json.error?.message ?? res.statusText });
      return 'UNKNOWN';
    }

    const rating = json.quality_rating ?? 'UNKNOWN';
    const { rows } = await this.pool.query<{ quality_rating: string | null }>(
      `SELECT quality_rating FROM channel_configs WHERE tenant_id = $1 AND channel = 'whatsapp'`,
      [tenantId]
    );
    const previous = rows[0]?.quality_rating ?? null;

    if (previous !== rating) {
      await this.pool.query(
        `UPDATE channel_configs
            SET quality_rating = $1, quality_updated_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $2 AND channel = 'whatsapp'`,
        [rating, tenantId]
      );
      await this.recordEvent(tenantId, 'poll', `QUALITY_${rating}`, previous, rating, { poll: true });

      if (rating === 'YELLOW' || rating === 'RED') {
        await publishEvent(TOPICS.NOTIFICATIONS, {
          tenantId,
          type: 'whatsapp_quality_event',
          severity: rating === 'RED' ? 'critical' : 'warning',
          title: `WhatsApp quality rating is ${rating}`,
          body:
            'Recipients are blocking or reporting messages from your number. ' +
            'Continued decline leads Meta to cut your messaging limits. ' +
            'Pause cold outreach and review your opt-in flow.',
        });
      }
    }
    return rating;
  }

  private async recordEvent(
    tenantId: string,
    source: string,
    eventType: string,
    oldValue: string | null,
    newValue: string | null,
    raw: unknown
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO channel_health_events
         (tenant_id, channel, source, event_type, old_value, new_value, raw)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6)`,
      [tenantId, source, eventType, oldValue, newValue, JSON.stringify(raw)]
    );
  }
}
