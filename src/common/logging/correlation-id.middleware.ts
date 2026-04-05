import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = Array.isArray(req.headers[CORRELATION_ID_HEADER])
      ? req.headers[CORRELATION_ID_HEADER][0]
      : req.headers[CORRELATION_ID_HEADER] || randomUUID();

    (req as Request & { correlationId: string }).correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const sanitizedUrl = this.sanitizeUrl(req.originalUrl);

      this.logger.log({
        message: 'HTTP Request',
        method: req.method,
        url: sanitizedUrl,
        statusCode: res.statusCode,
        durationMs: duration,
        correlationId,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
    });

    next();
  }

  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url, 'http://localhost');
      const sanitizedParams = new URLSearchParams();

      for (const [key, value] of parsed.searchParams) {
        if (this.isSensitiveParam(key)) {
          sanitizedParams.set(key, '[REDACTED]');
        } else {
          sanitizedParams.set(key, value);
        }
      }

      parsed.search = sanitizedParams.toString();
      return parsed.pathname + parsed.search;
    } catch {
      return url.split('?')[0] + (url.includes('?') ? '?[REDACTED]' : '');
    }
  }

  private isSensitiveParam(key: string): boolean {
    const sensitiveKeys = new Set([
      'token',
      'access_token',
      'refresh_token',
      'password',
      'secret',
      'api_key',
      'apikey',
      'authorization',
      'jwt',
      'otp',
    ]);

    return sensitiveKeys.has(key.toLowerCase());
  }
}
