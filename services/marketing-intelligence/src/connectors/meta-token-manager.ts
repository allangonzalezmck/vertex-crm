/**
 * Vertex CRM — Meta Token Manager (GAP-01 fix)
 *
 * WHY: Meta user access tokens expire (~60 days even when "long-lived").
 * Without exchange + expiry tracking + alerting, a tenant's Meta sync dies
 * silently two months after connecting — the exact Kommo failure mode.
 *
 * Responsibilities:
 *   1. Exchange short-lived OAuth tokens for long-lived ones at connect time.
 *   2. Persist token + expiry on connector_configs (migration 007 columns).
 *   3. Classify Meta auth errors (codes 190/102/463/467) so callers can mark
 *      the connector `needs_reauth` instead of retrying forever.
 *   4. Nightly sweep: warn tenants at T-7 days via the notification topic,
 *      and flag already-expired connectors.
 *
 * File location: services/marketing-intelligence/src/connectors/meta-token-manager.ts
 */

import { Pool } from 'pg';
import { createLogger, Logger } from '../../../../shared/src/utils/logger.js';
import { publishEvent, TOPICS } from '../../../../shared/src/utils/pubsub.js';

// Meta error codes that mean "the token is dead — do not retry":
// 190 = invalid/expired token · 102 = session invalidated
// 463 = token expired · 467 = token invalidated (password change / de-auth)
const AUTH_ERROR_CODES = new Set([190, 102, 463, 467]);

export function isMetaAuthError(code: number): boolean {
  return AUTH_ERROR_CODES.has(code);
}

/** Thrown by connectors when Meta rejects the credential itself. */
export class MetaAuthError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = 'MetaAuthError';
  }
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds until expiry. Absent for some system-user tokens (treat as 60d). */
  expires_in?: number;
}

export class MetaTokenManager {
  private readonly logger: Logger;
  private readonly graphBase: string;

  constructor(
    private readonly pool: Pool,
    private readonly appId: string = process.env.META_APP_ID ?? '',
    private readonly appSecret: string = process.env.META_APP_SECRET ?? '',
    apiVersion = 'v19.0'
  ) {
    this.logger = createLogger('meta-token-manager');
    this.graphBase = `https://graph.facebook.com/${apiVersion}`;
  }

  /**
   * Exchange a short-lived token (from the OAuth redirect) for a long-lived
   * one (~60 days) and persist it with its expiry. Call this ONCE at connect
   * time, before storing anything else.
   */
  async exchangeAndStore(tenantId: string, shortLivedToken: string): Promise<{ expiresAt: Date }> {
    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: shortLivedToken,
    });

    const res = await fetch(`${this.graphBase}/oauth/access_token?${params.toString()}`);
    const json = (await res.json()) as LongLivedTokenResponse & {
      error?: { message: string; code: number };
    };

    if (json.error) {
      if (isMetaAuthError(json.error.code)) {
        throw new MetaAuthError(json.error.message, json.error.code);
      }
      throw new Error(`Meta token exchange failed: ${json.error.message}`);
    }

    // Meta sometimes omits expires_in on long-lived exchanges; assume 60 days.
    const ttlSeconds = json.expires_in ?? 60 * 24 * 60 * 60;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.pool.query(
      `UPDATE connector_configs
          SET config_plain = COALESCE(config_plain, '{}'::jsonb)
                             || jsonb_build_object('accessToken', $1::text),
              token_expires_at = $2,
              auth_status = 'ok',
              updated_at = NOW()
        WHERE tenant_id = $3 AND platform = 'meta'`,
      [json.access_token, expiresAt, tenantId]
    );

    this.logger.info('Meta long-lived token stored', { tenantId, expiresAt: expiresAt.toISOString() });
    return { expiresAt };
  }

  /**
   * Mark a connector as needing re-authentication. Called by the sync job
   * when a MetaAuthError surfaces mid-sync. Also notifies the tenant.
   */
  async markNeedsReauth(tenantId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE connector_configs
          SET auth_status = 'needs_reauth', is_active = false, updated_at = NOW()
        WHERE tenant_id = $1 AND platform = 'meta'`,
      [tenantId]
    );
    await publishEvent(TOPICS.NOTIFICATIONS, {
      tenantId,
      type: 'connector_auth_expired',
      severity: 'critical',
      title: 'Meta connection needs re-authentication',
      body: `Your Meta (Facebook/Instagram) connection stopped working: ${reason}. ` +
            `Reconnect it under Settings → Integrations to resume ad-data sync.`,
    });
    this.logger.warn('Meta connector marked needs_reauth', { tenantId, reason });
  }

  /**
   * Nightly sweep (wire to Cloud Scheduler → POST /internal/token-sweep).
   * Warns tenants whose token expires within `warnDays`, and deactivates
   * connectors whose token is already past expiry.
   */
  async sweepExpiring(warnDays = 7): Promise<{ warned: number; expired: number }> {
    const { rows: expiring } = await this.pool.query<{ tenant_id: string; token_expires_at: Date }>(
      `SELECT tenant_id, token_expires_at
         FROM connector_configs
        WHERE platform = 'meta' AND is_active = true AND auth_status = 'ok'
          AND token_expires_at IS NOT NULL
          AND token_expires_at BETWEEN NOW() AND NOW() + ($1 || ' days')::interval`,
      [warnDays]
    );

    for (const row of expiring) {
      await this.pool.query(
        `UPDATE connector_configs SET auth_status = 'expiring_soon', updated_at = NOW()
          WHERE tenant_id = $1 AND platform = 'meta'`,
        [row.tenant_id]
      );
      await publishEvent(TOPICS.NOTIFICATIONS, {
        tenantId: row.tenant_id,
        type: 'connector_token_expiring',
        severity: 'warning',
        title: 'Meta connection expires soon',
        body: `Your Meta connection expires on ${row.token_expires_at.toISOString().slice(0, 10)}. ` +
              `Reconnect under Settings → Integrations to avoid any interruption.`,
      });
    }

    const { rows: dead } = await this.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM connector_configs
        WHERE platform = 'meta' AND is_active = true
          AND token_expires_at IS NOT NULL AND token_expires_at < NOW()`
    );
    for (const row of dead) {
      await this.markNeedsReauth(row.tenant_id, 'access token expired');
    }

    this.logger.info('Token sweep complete', { warned: expiring.length, expired: dead.length });
    return { warned: expiring.length, expired: dead.length };
  }
}
