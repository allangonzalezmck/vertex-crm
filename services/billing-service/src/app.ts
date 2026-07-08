/**
 * Vertex CRM — Billing Service (Paddle Edition)
 *
 * WHY PADDLE: Vertex CRM operates from Costa Rica. Stripe does not accept
 * Costa Rican merchants. Paddle acts as Merchant of Record (MoR): Paddle is
 * the legal seller, handles global VAT/sales tax in 200+ jurisdictions,
 * chargebacks, and fraud — and accepts merchants from Costa Rica with no
 * US/EU entity required. Payouts arrive via wire transfer or PayPal.
 *
 * Paddle Billing API (v2) reference: https://developer.paddle.com/api-reference
 * Auth: Bearer API key. Webhooks signed with HMAC-SHA256 (Paddle-Signature header).
 */

import Fastify from 'fastify';
import { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { createLogger } from '../../../shared/src/utils/logger';
import { publishEvent, TOPICS } from '../../../shared/src/utils/pubsub';

const logger = createLogger('billing-service');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PADDLE_API_BASE =
  process.env.PADDLE_ENV === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';
const PADDLE_API_KEY = process.env.PADDLE_API_KEY!;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET!;

// ── Plan definitions ─────────────────────────────────────────────────────────
// priceId values come from Paddle Dashboard → Catalog → Products → Prices
export const PLANS = {
  starter: {
    name: 'Starter',
    paddlePriceId: process.env.PADDLE_PRICE_STARTER!,
    limits: { seats: 3, leads: 1_000, aiConversations: 100, marketingConnectors: 1, workflowExecutions: 500 },
  },
  growth: {
    name: 'Growth',
    paddlePriceId: process.env.PADDLE_PRICE_GROWTH!,
    limits: { seats: 10, leads: 10_000, aiConversations: 1_000, marketingConnectors: 3, workflowExecutions: 5_000 },
  },
  scale: {
    name: 'Scale',
    paddlePriceId: process.env.PADDLE_PRICE_SCALE!,
    limits: { seats: 50, leads: 100_000, aiConversations: 10_000, marketingConnectors: 10, workflowExecutions: 50_000 },
  },
  enterprise: {
    name: 'Enterprise',
    paddlePriceId: process.env.PADDLE_PRICE_ENTERPRISE!,
    limits: { seats: -1, leads: -1, aiConversations: -1, marketingConnectors: -1, workflowExecutions: -1 },
  },
} as const;

type PlanKey = keyof typeof PLANS;
type LimitKey = keyof typeof PLANS.starter.limits;

// ── Paddle API client ────────────────────────────────────────────────────────
async function paddleRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${PADDLE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { data?: T; error?: { code: string; detail: string } };
  if (!res.ok || json.error) {
    logger.error({ status: res.status, error: json.error, path }, 'Paddle API error');
    throw new Error(`Paddle ${path}: ${json.error?.detail ?? res.statusText}`);
  }
  return json.data as T;
}

// ── Webhook signature verification (Paddle-Signature: ts=...;h1=...) ────────
function verifyPaddleSignature(rawBody: string, signatureHeader: string): boolean {
  try {
    const parts = Object.fromEntries(
      signatureHeader.split(';').map((kv) => kv.split('=') as [string, string])
    );
    const ts = parts['ts'];
    const h1 = parts['h1'];
    if (!ts || !h1) return false;

    // Reject stale webhooks (>5 min) to prevent replay attacks
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (age > 300) return false;

    const payload = `${ts}:${rawBody}`;
    const expected = createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(payload).digest('hex');
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(h1, 'hex'));
  } catch {
    return false;
  }
}

// ── Usage metering ───────────────────────────────────────────────────────────
async function getCurrentUsage(tenantId: string): Promise<Record<LimitKey, number>> {
  const client = await pool.connect();
  try {
    const [leads, seats, aiConv, connectors, workflows] = await Promise.all([
      client.query('SELECT COUNT(*)::int AS c FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL', [tenantId]),
      client.query('SELECT COUNT(*)::int AS c FROM users WHERE tenant_id = $1 AND is_active = true', [tenantId]),
      client.query(
        `SELECT COUNT(*)::int AS c FROM conversations WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`,
        [tenantId]
      ),
      client.query('SELECT COUNT(*)::int AS c FROM connector_configs WHERE tenant_id = $1 AND is_active = true', [tenantId]),
      client.query(
        `SELECT COUNT(*)::int AS c FROM workflow_executions WHERE tenant_id = $1 AND started_at >= date_trunc('month', now())`,
        [tenantId]
      ),
    ]);
    return {
      leads: leads.rows[0].c,
      seats: seats.rows[0].c,
      aiConversations: aiConv.rows[0].c,
      marketingConnectors: connectors.rows[0].c,
      workflowExecutions: workflows.rows[0].c,
    };
  } finally {
    client.release();
  }
}

async function getTenantPlan(tenantId: string): Promise<{ plan: PlanKey; status: string; paddleSubscriptionId: string | null }> {
  const { rows } = await pool.query(
    'SELECT plan, billing_status, paddle_subscription_id FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (!rows.length) throw new Error(`Tenant ${tenantId} not found`);
  return {
    plan: (rows[0].plan || 'starter') as PlanKey,
    status: rows[0].billing_status || 'trialing',
    paddleSubscriptionId: rows[0].paddle_subscription_id,
  };
}

function priceIdToPlan(priceId: string): PlanKey {
  const match = (Object.entries(PLANS) as [PlanKey, (typeof PLANS)[PlanKey]][]).find(
    ([, p]) => p.paddlePriceId === priceId
  );
  return match?.[0] ?? 'starter';
}

// ── Fastify app ──────────────────────────────────────────────────────────────
const app = Fastify({ logger: false });

// Raw body capture required for webhook HMAC verification
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as any).rawBody = body;
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error);
  }
});

app.get('/health', async () => ({ status: 'ok', service: 'billing-service', processor: 'paddle' }));
app.get('/ready', async () => {
  await pool.query('SELECT 1');
  return { status: 'ready' };
});

// GET /billing/:tenantId — usage + plan overview for the billing page
app.get<{ Params: { tenantId: string } }>('/billing/:tenantId', async (req) => {
  const { tenantId } = req.params;
  const [{ plan, status, paddleSubscriptionId }, usage] = await Promise.all([
    getTenantPlan(tenantId),
    getCurrentUsage(tenantId),
  ]);
  const limits = PLANS[plan].limits;
  const utilization = Object.fromEntries(
    (Object.keys(usage) as LimitKey[]).map((k) => [
      k,
      {
        used: usage[k],
        limit: limits[k],
        pct: limits[k] === -1 ? 0 : Math.round((usage[k] / limits[k]) * 100),
        unlimited: limits[k] === -1,
      },
    ])
  );
  return { tenantId, plan, planName: PLANS[plan].name, status, paddleSubscriptionId, utilization };
});

// POST /billing/:tenantId/check-limit — enforcement gate called by other services
app.post<{ Params: { tenantId: string }; Body: { resource: LimitKey; incrementBy?: number } }>(
  '/billing/:tenantId/check-limit',
  async (req, reply) => {
    const { tenantId } = req.params;
    const { resource, incrementBy = 1 } = req.body;

    const [{ plan, status }, usage] = await Promise.all([getTenantPlan(tenantId), getCurrentUsage(tenantId)]);

    if (status !== 'active' && status !== 'trialing') {
      return reply.status(402).send({
        allowed: false,
        reason: 'subscription_inactive',
        message: 'Your subscription is inactive. Please update your payment method.',
      });
    }

    const limit = PLANS[plan].limits[resource];
    if (limit === -1) return { allowed: true };

    const current = usage[resource];
    if (current + incrementBy > limit) {
      return reply.status(402).send({
        allowed: false,
        reason: 'limit_exceeded',
        resource,
        used: current,
        limit,
        plan,
        upgradeUrl: `${process.env.APP_URL}/billing/upgrade`,
        message: `You've reached the ${resource} limit for your ${PLANS[plan].name} plan.`,
      });
    }

    const pct = Math.round(((current + incrementBy) / limit) * 100);
    if (pct >= 90) {
      publishEvent(TOPICS.BILLING_LIMIT_WARNING, { tenantId, resource, used: current + incrementBy, limit, pct }).catch(
        () => {}
      );
    }
    return { allowed: true, used: current, limit, pct };
  }
);

/**
 * POST /billing/checkout — create a Paddle transaction for hosted checkout.
 * The frontend opens Paddle.js overlay checkout with the returned txn id:
 *   Paddle.Checkout.open({ transactionId })
 * customData.tenantId links the Paddle subscription back to our tenant.
 */
app.post<{ Body: { tenantId: string; plan: PlanKey; customerEmail: string } }>(
  '/billing/checkout',
  async (req, reply) => {
    const { tenantId, plan, customerEmail } = req.body;
    const planDef = PLANS[plan];
    if (!planDef) return reply.status(400).send({ error: 'Invalid plan' });

    const txn = await paddleRequest<{ id: string; checkout: { url: string } }>('POST', '/transactions', {
      items: [{ price_id: planDef.paddlePriceId, quantity: 1 }],
      customer: { email: customerEmail },
      custom_data: { tenantId, plan },
      checkout: { url: `${process.env.APP_URL}/billing/success` },
    });

    return { transactionId: txn.id, checkoutUrl: txn.checkout?.url ?? null };
  }
);

// POST /billing/portal — Paddle customer portal link (manage payment method, cancel)
app.post<{ Body: { tenantId: string } }>('/billing/portal', async (req, reply) => {
  const { rows } = await pool.query('SELECT paddle_customer_id FROM tenants WHERE id = $1', [req.body.tenantId]);
  const customerId = rows[0]?.paddle_customer_id;
  if (!customerId) return reply.status(404).send({ error: 'No Paddle customer found for tenant' });

  const session = await paddleRequest<{ urls: { general: { overview: string } } }>(
    'POST',
    `/customers/${customerId}/portal-sessions`,
    {}
  );
  return { url: session.urls.general.overview };
});

// POST /billing/cancel — schedule cancellation at end of billing period
app.post<{ Body: { tenantId: string } }>('/billing/cancel', async (req, reply) => {
  const { paddleSubscriptionId } = await getTenantPlan(req.body.tenantId);
  if (!paddleSubscriptionId) return reply.status(404).send({ error: 'No active subscription' });

  await paddleRequest('POST', `/subscriptions/${paddleSubscriptionId}/cancel`, {
    effective_from: 'next_billing_period',
  });
  return { scheduled: true };
});

/**
 * POST /billing/webhooks/paddle — Paddle event ingestion.
 * Events: https://developer.paddle.com/webhooks/overview
 */
app.post('/billing/webhooks/paddle', async (req, reply) => {
  const signature = req.headers['paddle-signature'] as string | undefined;
  const rawBody = (req as any).rawBody as string;

  if (!signature || !verifyPaddleSignature(rawBody, signature)) {
    logger.warn('Paddle webhook signature verification failed');
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const event = req.body as {
    event_type: string;
    data: {
      id: string;
      status?: string;
      customer_id?: string;
      custom_data?: { tenantId?: string; plan?: string };
      items?: Array<{ price?: { id: string } }>;
    };
  };

  logger.info({ type: event.event_type }, 'Paddle webhook received');

  try {
    await handlePaddleEvent(event);
  } catch (err) {
    logger.error({ err, type: event.event_type }, 'Paddle webhook handler error');
    // Return 500 so Paddle retries (Paddle retries with backoff for 3 days)
    return reply.status(500).send({ error: 'Handler failed' });
  }
  return { received: true };
});

async function handlePaddleEvent(event: {
  event_type: string;
  data: {
    id: string;
    status?: string;
    customer_id?: string;
    custom_data?: { tenantId?: string; plan?: string };
    items?: Array<{ price?: { id: string } }>;
  };
}): Promise<void> {
  const d = event.data;
  const tenantId = d.custom_data?.tenantId;

  switch (event.event_type) {
    // Fired when a subscription is first created after successful checkout
    case 'subscription.created':
    case 'subscription.activated': {
      if (!tenantId) {
        logger.warn({ subscriptionId: d.id }, 'subscription event missing tenantId in custom_data');
        return;
      }
      const priceId = d.items?.[0]?.price?.id ?? '';
      const plan = d.custom_data?.plan ?? priceIdToPlan(priceId);
      await pool.query(
        `UPDATE tenants SET plan = $1, billing_status = 'active',
           paddle_customer_id = $2, paddle_subscription_id = $3, updated_at = now()
         WHERE id = $4`,
        [plan, d.customer_id, d.id, tenantId]
      );
      await publishEvent(TOPICS.BILLING_PLAN_CHANGED, { tenantId, plan, status: 'active' });
      break;
    }

    case 'subscription.updated': {
      const priceId = d.items?.[0]?.price?.id ?? '';
      const plan = priceIdToPlan(priceId);
      // Map Paddle statuses to our internal statuses
      const statusMap: Record<string, string> = {
        active: 'active',
        trialing: 'trialing',
        past_due: 'past_due',
        paused: 'paused',
        canceled: 'canceled',
      };
      const status = statusMap[d.status ?? 'active'] ?? 'active';
      await pool.query(
        `UPDATE tenants SET plan = $1, billing_status = $2, updated_at = now()
         WHERE paddle_subscription_id = $3`,
        [plan, status, d.id]
      );
      if (tenantId) await publishEvent(TOPICS.BILLING_PLAN_CHANGED, { tenantId, plan, status });
      break;
    }

    case 'subscription.canceled': {
      await pool.query(
        `UPDATE tenants SET billing_status = 'canceled', plan = 'starter', updated_at = now()
         WHERE paddle_subscription_id = $1`,
        [d.id]
      );
      break;
    }

    case 'subscription.past_due': {
      await pool.query(
        `UPDATE tenants SET billing_status = 'past_due', updated_at = now()
         WHERE paddle_subscription_id = $1`,
        [d.id]
      );
      break;
    }

    // Payment recovered after dunning
    case 'transaction.completed': {
      if (d.customer_id) {
        await pool.query(
          `UPDATE tenants SET billing_status = 'active', updated_at = now()
           WHERE paddle_customer_id = $1 AND billing_status = 'past_due'`,
          [d.customer_id]
        );
      }
      break;
    }

    default:
      logger.info({ type: event.event_type }, 'Unhandled Paddle event (ignored)');
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await app.listen({ port: 8080, host: '0.0.0.0' });
    logger.info('billing-service (Paddle) listening on :8080');
  } catch (err) {
    logger.error({ err }, 'Failed to start billing-service');
    process.exit(1);
  }
};

start();
