/**
 * @file shared/src/utils/database.ts
 * @description PostgreSQL connection pool with tenant RLS enforcement.
 * Every query MUST go through getTenantClient() to guarantee RLS.
 * Direct pool.query() is reserved for admin/migration operations only.
 *
 * Architecture note: We use node-postgres (pg) directly rather than an ORM
 * for the connection layer. Drizzle ORM sits on top for schema/migrations.
 * This gives us precise control over RLS SET LOCAL commands per transaction.
 */

import { Pool, PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { TenantId } from '../types/index.js';
import type { Logger } from './logger.js';

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean | { rejectUnauthorized: boolean };
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

interface TenantClient {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  release: () => void;
  tenantId: TenantId;
}

/**
 * Singleton pool — Cloud Run containers share one pool per cold start.
 * PgBouncer handles the actual connection pooling to Cloud SQL.
 */
let pool: Pool | null = null;

export function createPool(config: DatabaseConfig): Pool {
  if (pool) return pool;

  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    max: config.maxConnections ?? 10, // per Cloud Run instance
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
    // Application name for pg_stat_activity visibility
    application_name: process.env['SERVICE_NAME'] ?? 'vertex-service',
  });

  pool.on('error', (err) => {
    // Pool errors are non-fatal — log and let pg recover
    process.stderr.write(
      JSON.stringify({
        severity: 'ERROR',
        message: 'Database pool error',
        error: { name: err.name, message: err.message },
        service: process.env['SERVICE_NAME'],
      }) + '\n'
    );
  });

  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call createPool() first.');
  }
  return pool;
}

/**
 * Get a tenant-scoped database client.
 * Sets PostgreSQL's app.current_tenant_id for the duration of the client's use.
 * RLS policies on all tables read this setting to filter rows.
 *
 * CRITICAL: Always call client.release() in a finally block.
 * Never pass tenant_id in SQL string interpolation.
 */
export async function getTenantClient(
  tenantId: TenantId,
  logger?: Logger
): Promise<TenantClient> {
  const dbPool = getPool();
  const rawClient: PoolClient = await dbPool.connect();

  try {
    // Set tenant context for RLS — parameterized to prevent injection
    // PostgreSQL executes this as: SET LOCAL app.current_tenant_id = 'uuid-here'
    await rawClient.query(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      [tenantId]
    );
  } catch (err) {
    rawClient.release();
    throw new DatabaseError('Failed to set tenant context', err);
  }

  const tenantClient: TenantClient = {
    tenantId,

    async query<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<QueryResult<R>> {
      // Guard: prevent accidental tenant_id string interpolation in callers
      if (sql.includes('${') || sql.includes("'+")) {
        throw new DatabaseError(
          'SQL string interpolation detected. Use parameterized queries only.'
        );
      }

      const start = Date.now();
      try {
        const result = await rawClient.query<R>(sql, params);
        logger?.debug('Query executed', {
          duration: Date.now() - start,
          rowCount: result.rowCount,
          // Never log the actual SQL in production (may contain sensitive data)
          queryHash: hashQuery(sql),
        });
        return result;
      } catch (err) {
        logger?.error('Query failed', err, {
          duration: Date.now() - start,
          queryHash: hashQuery(sql),
        });
        throw new DatabaseError('Query execution failed', err);
      }
    },

    release(): void {
      rawClient.release();
    },
  };

  return tenantClient;
}

/**
 * Execute a function within a transaction, automatically rolling back on error.
 * The tenant client passed to fn is the same tenant-scoped client.
 */
export async function withTransaction<T>(
  tenantId: TenantId,
  fn: (client: TenantClient) => Promise<T>,
  logger?: Logger
): Promise<T> {
  const client = await getTenantClient(tenantId, logger);

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admin client — bypasses tenant RLS.
 * Used ONLY for: migrations, system tasks, cross-tenant analytics.
 * Never expose to request handlers.
 */
export async function getAdminClient(): Promise<PoolClient> {
  const dbPool = getPool();
  const client = await dbPool.connect();
  // Set admin context to allow bypassing RLS (role vertex_admin has BYPASSRLS)
  await client.query(`SET ROLE vertex_admin`);
  return client;
}

/**
 * Health check — returns true if pool can acquire and query a connection.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const dbPool = getPool();
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a database config from environment variables.
 * Called at service startup; values come from Secret Manager via env injection.
 */
export function buildDatabaseConfig(): DatabaseConfig {
  const host = process.env['DB_HOST'];
  const password = process.env['DB_PASSWORD'];

  if (!host || !password) {
    throw new Error('DB_HOST and DB_PASSWORD environment variables are required');
  }

  return {
    host,
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    database: process.env['DB_NAME'] ?? 'vertex_crm',
    user: process.env['DB_USER'] ?? 'vertex_app',
    password,
    ssl: process.env['DB_SSL'] === 'false'
      ? false
      : { rejectUnauthorized: process.env['NODE_ENV'] === 'production' },
    maxConnections: parseInt(process.env['DB_MAX_CONNECTIONS'] ?? '10', 10),
  };
}

export class DatabaseError extends Error {
  public readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DatabaseError';
    this.cause = cause;
  }
}

/** Simple FNV-1a hash for query logging without exposing SQL content */
function hashQuery(sql: string): string {
  let hash = 2166136261;
  for (let i = 0; i < sql.length; i++) {
    hash ^= sql.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
