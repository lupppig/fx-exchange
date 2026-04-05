import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { CORRELATION_ID_HEADER } from '../logging/correlation-id.middleware.js';

const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordHash',
  'passwordConfirmation',
  'currentPassword',
  'newPassword',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'secret',
  'api_key',
  'otp',
  'jwt',
]);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    const responseBody: Record<string, unknown> = {
      success: false,
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
    };

    if (typeof message === 'object' && message !== null) {
      const { message: msg, error } = message as Record<string, unknown>;
      responseBody.message = msg || error || 'An error occurred';
    } else {
      responseBody.message = message;
    }

    const correlationId = request[CORRELATION_ID_HEADER];
    if (correlationId) {
      responseBody.correlationId = correlationId;
    }

    if (httpStatus >= 500) {
      const sanitizedException = this.sanitizeException(exception);

      this.logger.error(
        {
          message: 'Unhandled exception',
          url: request.originalUrl,
          method: request.method,
          statusCode: httpStatus,
          correlationId,
          exception: sanitizedException,
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }

  private sanitizeException(exception: unknown): unknown {
    if (exception instanceof Error) {
      const sanitized: Record<string, unknown> = {
        name: exception.name,
        message: exception.message,
        stack: exception.stack,
      };

      for (const key of Object.keys(exception)) {
        if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = (exception as unknown as Record<string, unknown>)[
            key
          ];
        }
      }

      return sanitized;
    }

    if (typeof exception === 'object' && exception !== null) {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(exception)) {
        if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }

    return exception;
  }
}
