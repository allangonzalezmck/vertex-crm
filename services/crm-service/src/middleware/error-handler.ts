/**
 * @file services/crm-service/src/middleware/error-handler.ts
 * @description Centralized Fastify error handler. Maps domain errors to
 * HTTP status codes, sanitizes error messages for production, and
 * emits structured logs for Cloud Logging.
 */

import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import type { Logger } from '@vertex/shared/utils/logger';

// ─── Domain Error Classes ────────────────────────────────────────────────────

export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code: string;
  constructor(resource: string, id?: string) {
    super(id ? `${resource} '${id}' not found` : `${resource} not found`);
    this.code = 'NOT_FOUND';
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;
  constructor(message: string) {
    super(message);
    this.code = 'CONFLICT';
    this.name = 'ConflictError';
  }
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly code: string;
  constructor(message = 'Insufficient permissions') {
    super(message);
    this.code = 'FORBIDDEN';
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends Error {
  readonly statusCode = 422;
  readonly code: string;
  readonly fields?: Record<string, string[]>;
  constructor(message: string, fields?: Record<string, string[]>) {
    super(message);
    this.code = 'VALIDATION_ERROR';
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds}s`);
    this.name = 'RateLimitError';
  }
}

// ─── Error Classifier ────────────────────────────────────────────────────────

function classifyError(err: unknown): {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
} {
  // Domain errors
  if (err instanceof NotFoundError) {
    return { statusCode: 404, code: err.code, message: err.message };
  }
  if (err instanceof ConflictError) {
    return { statusCode: 409, code: err.code, message: err.message };
  }
  if (err instanceof ForbiddenError) {
    return { statusCode: 403, code: err.code, message: err.message };
  }
  if (err instanceof RateLimitError) {
    return {
      statusCode: 429,
      code: err.code,
      message: err.message,
      details: { retryAfterSeconds: err.retryAfterSeconds },
    };
  }
  if (err instanceof ValidationError) {
    return {
      statusCode: 422,
      code: err.code,
      message: err.message,
      details: err.fields,
    };
  }

  // Zod validation errors (from request body parsing)
  if (err instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const path = issue.path.join('.') || '_root';
      (fields[path] ??= []).push(issue.message);
    }
    return {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: { fields },
    };
  }

  // Fastify built-in errors (e.g. 404 from route not found, 400 from JSON parse)
  const fastifyErr = err as FastifyError;
  if (fastifyErr.statusCode) {
    return {
      statusCode: fastifyErr.statusCode,
      code: fastifyErr.code ?? 'REQUEST_ERROR',
      message: fastifyErr.message,
    };
  }

  // PostgreSQL errors
  if ((err as any).code?.startsWith('23')) {
    // Integrity constraint violations
    const pgCode = (err as any).code;
    if (pgCode === '23505') {
      return { statusCode: 409, code: 'CONFLICT', message: 'Resource already exists' };
    }
    if (pgCode === '23503') {
      return { statusCode: 422, code: 'VALIDATION_ERROR', message: 'Referenced resource does not exist' };
    }
    return { statusCode: 422, code: 'CONSTRAINT_VIOLATION', message: 'Database constraint violation' };
  }

  // Unknown — 500
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : (err as Error).message ?? 'Unknown error',
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────


export function errorHandler(logger: Logger) {
  return function handler(
    err: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply
  ): void {
    const classified = classifyError(err);

    if (classified.statusCode >= 500) {
      logger.error('Unhandled server error', err, {
        requestId: request.id,
        method: request.method,
        url: request.url,
        tenantId: (request as any).tenantId,
        userId: (request as any).userId,
      });
    } else if (classified.statusCode >= 400) {
      logger.warn('Client error', {
        code: classified.code,
        message: classified.message,
        requestId: request.id,
        method: request.method,
        url: request.url,
        tenantId: (request as any).tenantId,
      });
    }

    reply.code(classified.statusCode).send({
      success: false,
      error: {
        code: classified.code,
        message: classified.message,
        ...(classified.details ? { details: classified.details } : {}),
      },
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  };
}
