import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    const responseBody: any = {
      success: false,
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
    };

    if (typeof message === 'object' && message !== null) {
      const { statusCode, error, message: msg, ...rest } = message as any;
      if (rest.errors) {
        responseBody.errors = rest.errors;
      } else {
        responseBody.message = msg || error || 'An error occurred';
      }
    } else {
      responseBody.message = message;
    }

    if (httpStatus >= 500) {
      this.logger.error(
        `Exception occurred at ${httpAdapter.getRequestUrl(ctx.getRequest())}`,
        exception instanceof Error ? exception.stack : JSON.stringify(exception),
      );
    }

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}
