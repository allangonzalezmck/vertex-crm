/**
 * @file services/workflow-engine/src/app.ts
 * @description Workflow Engine service — evaluates trigger conditions and
 * executes action chains (send email, update field, create activity, etc).
 * Triggered via Pub/Sub push from crm-events and ai-agent topics.
 */

import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { createLogger } from '@vertex/shared/utils/logger';
import { getTenantClient, withTransaction } from '@vertex/shared/utils/database';
import { publishEvent, TOPICS } from '@vertex/shared/utils/pubsub';
import type { TenantId } from '@vertex/shared/types';

const logger = createLogger('workflow-engine');

// ─── Trigger Types ────────────────────────────────────────────────────────────

type TriggerType =
  | 'lead.created' | 'lead.status_changed' | 'lead.score_changed'
  | 'deal.created' | 'deal.stage_changed' | 'deal.won' | 'deal.lost'
  | 'activity.completed' | 'contact.created'
  | 'time.scheduled';

type ActionType =
  | 'send_email' | 'send_sms' | 'create_activity' | 'update_field'
  | 'assign_owner' | 'add_tag' | 'remove_tag' | 'create_deal'
  | 'notify_user' | 'webhook' | 'wait';

interface WorkflowCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'is_null' | 'is_not_null';
  value?: unknown;
}

interface WorkflowAction {
  type: ActionType;
  config: Record<string, unknown>;
  delaySeconds?: number;
}

interface Workflow {
  id: string;
  tenantId: TenantId;
  name: string;
  triggerType: TriggerType;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  isActive: boolean;
}

// ─── Condition Evaluator ──────────────────────────────────────────────────────

function evaluateCondition(condition: WorkflowCondition, payload: Record<string, unknown>): boolean {
  const fieldValue = getNestedValue(payload, condition.field);
  const { operator, value } = condition;

  switch (operator) {
    case 'equals':      return fieldValue == value;
    case 'not_equals':  return fieldValue != value;
    case 'contains':    return typeof fieldValue === 'string' && fieldValue.includes(String(value));
    case 'gt':          return Number(fieldValue) > Number(value);
    case 'lt':          return Number(fieldValue) < Number(value);
    case 'gte':         return Number(fieldValue) >= Number(value);
    case 'lte':         return Number(fieldValue) <= Number(value);
    case 'is_null':     return fieldValue == null;
    case 'is_not_null': return fieldValue != null;
    default:            return false;
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((curr, key) => {
    if (curr != null && typeof curr === 'object') {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function evaluateConditions(conditions: WorkflowCondition[], payload: Record<string, unknown>): boolean {
  return conditions.every(c => evaluateCondition(c, payload));
}

// ─── Action Executors ─────────────────────────────────────────────────────────

async function executeAction(
  action: WorkflowAction,
  payload: Record<string, unknown>,
  tenantId: TenantId,
  db: Awaited<ReturnType<typeof getTenantClient>>,
  executionId: string
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    switch (action.type) {
      case 'update_field': {
        const { entity, entityId, field, value } = action.config as any;
        const entityId_ = entityId === '$trigger.id'
          ? (payload as any).id ?? (payload as any)[`${entity}Id`]
          : entityId;

        const tableMap: Record<string, string> = {
          lead: 'leads', contact: 'contacts', deal: 'deals', account: 'accounts',
        };
        const table = tableMap[entity];
        if (!table || !entityId_) return { success: false, error: 'Invalid entity config' };

        await db.query(
          `UPDATE ${table} SET ${field} = $1, updated_at = NOW() WHERE id = $2`,
          [value, entityId_]
        );
        return { success: true };
      }

      case 'add_tag': {
        const { entity, entityId, tag } = action.config as any;
        const entityId_ = entityId === '$trigger.id' ? (payload as any).id : entityId;
        const tableMap: Record<string, string> = { lead: 'leads', contact: 'contacts' };
        const table = tableMap[entity];
        if (!table) return { success: false, error: 'Invalid entity' };

        await db.query(
          `UPDATE ${table} SET tags = array_append(tags, $1) WHERE id = $2 AND NOT ($1 = ANY(tags))`,
          [tag, entityId_]
        );
        return { success: true };
      }

      case 'create_activity': {
        const leadId = (payload as any).id ?? (payload as any).leadId;
        const contactId = (payload as any).contactId;
        const dealId = (payload as any).dealId;

        await db.query(
          `INSERT INTO activities (type, subject, notes, lead_id, contact_id, deal_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'system')`,
          [
            action.config.type ?? 'note',
            action.config.subject ?? 'Automated activity',
            action.config.notes ?? null,
            leadId ?? null, contactId ?? null, dealId ?? null,
          ]
        );
        return { success: true };
      }

      case 'notify_user': {
        // Publish notification event — notification-service handles delivery
        await publishEvent(
          TOPICS.NOTIFICATIONS,
          'workflow.notification',
          tenantId,
          {
            userId: action.config.userId ?? (payload as any).ownerId,
            title: action.config.title,
            body: action.config.body,
            entityType: action.config.entityType,
            entityId: (payload as any).id,
          }
        );
        return { success: true };
      }

      case 'send_email': {
        // Publish to notification topic — notification-service handles SMTP/SendGrid
        await publishEvent(
          TOPICS.NOTIFICATIONS,
          'workflow.send_email',
          tenantId,
          {
            to: action.config.to === '$trigger.email' ? (payload as any).email : action.config.to,
            templateId: action.config.templateId,
            variables: { ...payload, ...((action.config.variables as object) ?? {}) },
          }
        );
      }

      case 'webhook': {
        const response = await fetch(action.config.url as string, {
          method: (action.config.method as string) ?? 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...((action.config.headers as Record<string, string>) ?? {}),
          },
          body: JSON.stringify({ payload, tenantId, executionId }),
        });
        return { success: response.ok, result: { status: response.status } };
      }

      case 'wait': {
        // Delay handled by scheduling — noop here (actual delay via Cloud Tasks)
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Workflow Processor ───────────────────────────────────────────────────────

async function processEvent(
  triggerType: TriggerType,
  tenantId: TenantId,
  payload: Record<string, unknown>
): Promise<void> {
  const db = await getTenantClient(tenantId);
  const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  try {
    // Load active workflows for this trigger type
    const workflowsResult = await db.query(
      `SELECT id, name, conditions, actions
       FROM workflows
       WHERE trigger_type = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [triggerType]
    );

    for (const wfRow of workflowsResult.rows) {
      const conditions: WorkflowCondition[] = wfRow.conditions ?? [];
      const actions: WorkflowAction[] = wfRow.actions ?? [];

      // Evaluate conditions
      if (!evaluateConditions(conditions, payload)) {
        continue;
      }

      logger.info('Executing workflow', { workflowId: wfRow.id, triggerType, tenantId });

      // Record execution start
      const execResult = await db.query(
        `INSERT INTO workflow_executions (workflow_id, trigger_type, trigger_payload, status, started_at)
         VALUES ($1, $2, $3, 'running', NOW()) RETURNING id`,
        [wfRow.id, triggerType, JSON.stringify(payload)]
      );
      const dbExecutionId = execResult.rows[0].id;

      // Execute actions sequentially
      const actionResults: unknown[] = [];
      let allSucceeded = true;

      for (const action of actions) {
        const result = await executeAction(action, payload, tenantId, db, executionId);
        actionResults.push({ type: action.type, ...result });
        if (!result.success) {
          allSucceeded = false;
          logger.warn('Action failed', { workflowId: wfRow.id, action: action.type, error: result.error });
          break; // Stop on failure
        }
      }

      // Update execution record
      await db.query(
        `UPDATE workflow_executions SET
           status = $1, completed_at = NOW(), action_results = $2
         WHERE id = $3`,
        [allSucceeded ? 'completed' : 'failed', JSON.stringify(actionResults), dbExecutionId]
      );
    }
  } finally {
    await (db as any).release?.();
  }
}

// ─── Fastify App ──────────────────────────────────────────────────────────────

const app = Fastify({ logger: false, genReqId: () => `wf-${Date.now()}` });

app.register(helmet, { contentSecurityPolicy: false });
app.register(cors, { origin: false });

// Health
app.get('/health', async () => ({ status: 'ok', service: 'workflow-engine' }));
app.get('/ready', async (_, reply) => {
  try {
    const db = await getTenantClient('health-check' as TenantId);
    await db.query('SELECT 1');
    await (db as any).release?.();
    return { status: 'ready' };
  } catch {
    return reply.code(503).send({ status: 'unhealthy' });
  }
});

// Pub/Sub push endpoint — receives events from CRM and AI agent topics
app.post('/pubsub', async (request, reply) => {
  const body = request.body as any;

  // Verify Pub/Sub message format
  if (!body?.message?.data) {
    return reply.code(200).send(); // 200 to avoid Pub/Sub retry on bad format
  }

  let event: { type: TriggerType; tenantId: TenantId; payload: Record<string, unknown> };
  try {
    const decoded = Buffer.from(body.message.data, 'base64').toString('utf8');
    event = JSON.parse(decoded);
  } catch {
    logger.warn('Failed to decode Pub/Sub message');
    return reply.code(200).send();
  }

  if (!event.type || !event.tenantId || !event.payload) {
    return reply.code(200).send();
  }

  try {
    await processEvent(event.type as TriggerType, event.tenantId, event.payload);
  } catch (err) {
    logger.error('Workflow processing error', err, { eventType: event.type, tenantId: event.tenantId });
    // Return 200 to prevent DLQ for transient errors; rely on workflow_executions for retry
  }

  return reply.code(200).send({ processed: true });
});

// Manual trigger (admin/testing)
app.post('/trigger', async (request, reply) => {
  const { triggerType, tenantId, payload } = request.body as any;

  if (!triggerType || !tenantId || !payload) {
    return reply.code(400).send({ error: 'Missing triggerType, tenantId, or payload' });
  }

  await processEvent(triggerType, tenantId, payload);
  return reply.send({ triggered: true });
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down workflow-engine');
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const start = async () => {
  try {
    const port = parseInt(process.env.PORT ?? '8080', 10);
    await app.listen({ port, host: '0.0.0.0' });
    logger.info('Workflow engine started', { port });
  } catch (err) {
    logger.error('Failed to start workflow engine', err);
    process.exit(1);
  }
};

start();

export { app };
