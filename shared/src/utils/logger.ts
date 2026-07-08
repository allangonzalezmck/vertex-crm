/**
 * @file shared/src/utils/logger.ts
 * @description Structured JSON logger for all Vertex CRM services.
 * Cloud Logging compatible. Never emits console.log in production paths.
 * In GCP, stdout JSON logs are automatically parsed by Cloud Logging.
 */

import type { StructuredLog, TenantId, UserId } from '../types/index.js';

type LogSeverity = StructuredLog['severity'];

interface LogContext {
  service: string;
  version?: string;
  traceId?: string;
  spanId?: string;
  tenantId?: TenantId;
  userId?: UserId;
  requestId?: string;
}

interface LogEntry extends LogContext {
  severity: LogSeverity;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

class Logger {
  private readonly context: LogContext;
  private readonly isProduction: boolean;

  constructor(context: LogContext) {
    this.context = context;
    this.isProduction = process.env['NODE_ENV'] === 'production';
  }

  /**
   * Create a child logger with additional context merged in.
   * Use for request-scoped logging (adds traceId, tenantId, requestId).
   */
  child(additionalContext: Partial<LogContext>): Logger {
    return new Logger({ ...this.context, ...additionalContext });
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (this.isProduction) return; // Skip debug in production
    this.emit('DEBUG', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.emit('INFO', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.emit('WARNING', message, extra);
  }

  error(
    message: string,
    error?: Error | unknown,
    extra?: Record<string, unknown>
  ): void {
    const errorDetails = error instanceof Error
      ? {
          error: {
            name: error.name,
            message: error.message,
            // Only include stack in non-production to prevent data leakage
            stack: this.isProduction ? undefined : error.stack,
            code: (error as NodeJS.ErrnoException).code,
          },
        }
      : error
        ? { error }
        : {};

    this.emit('ERROR', message, { ...errorDetails, ...extra });
  }

  critical(
    message: string,
    error?: Error | unknown,
    extra?: Record<string, unknown>
  ): void {
    const errorDetails = error instanceof Error
      ? {
          error: {
            name: error.name,
            message: error.message,
            stack: this.isProduction ? undefined : error.stack,
          },
        }
      : error
        ? { error }
        : {};

    this.emit('CRITICAL', message, { ...errorDetails, ...extra });
  }

  /**
   * Log with timing for performance-sensitive operations.
   * Usage: const done = logger.startTimer('db.query'); await query(); done();
   */
  startTimer(operation: string, extra?: Record<string, unknown>): () => void {
    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      this.info(`${operation} completed`, { ...extra, duration, operation });
    };
  }

  private emit(
    severity: LogSeverity,
    message: string,
    extra?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      severity,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...extra,
    };

    // Cloud Logging interprets 'logging.googleapis.com/trace' for trace correlation
    if (this.context.traceId) {
      const projectId = process.env['GOOGLE_CLOUD_PROJECT'] ?? 'local';
      (entry as Record<string, unknown>)['logging.googleapis.com/trace'] =
        `projects/${projectId}/traces/${this.context.traceId}`;
      (entry as Record<string, unknown>)['logging.googleapis.com/spanId'] =
        this.context.spanId;
    }

    // In development, pretty-print; in production, emit compact JSON
    if (this.isProduction) {
      process.stdout.write(JSON.stringify(entry) + '\n');
    } else {
      const color = SEVERITY_COLORS[severity];
      const reset = '\x1b[0m';
      const prefix = `${color}[${severity}]${reset} ${entry.timestamp}`;
      // eslint-disable-next-line no-console
      console.log(`${prefix} ${message}`, extra ?? '');
    }
  }
}

const SEVERITY_COLORS: Record<LogSeverity, string> = {
  DEBUG: '\x1b[37m',    // white
  INFO: '\x1b[36m',     // cyan
  WARNING: '\x1b[33m',  // yellow
  ERROR: '\x1b[31m',    // red
  CRITICAL: '\x1b[35m', // magenta
};

/**
 * Create a service-level logger instance.
 * Each Cloud Run service creates one at startup and passes it via DI.
 */
export function createLogger(service: string, version?: string): Logger {
  return new Logger({
    service,
    version: version ?? process.env['SERVICE_VERSION'] ?? 'unknown',
  });
}

export { Logger };
