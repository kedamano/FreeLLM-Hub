import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { redactSecrets } from '../security/secret-redaction.js';
import { auditRejectedRequest, completeRequestAudit } from '../../usage/audit-recorder.js';

export function registerCommonMiddleware(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.log.debug({ url: request.url, method: request.method }, 'incoming request');
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const responseTime = reply.elapsedTime;
    // `request.id` is the same id the audit row and the OpenAI-shaped response body
    // use, so a line in gateway.log can be grepped straight into the audit panel.
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: `${responseTime.toFixed(2)}ms`,
      },
      'request completed'
    );
    return payload;
  });

  app.addHook('onError', async (request: FastifyRequest, reply: FastifyReply, error) => {
    request.log.error(
      {
        err: error,
        url: request.url,
        method: request.method,
      },
      'unhandled error'
    );
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // Body-size and parse failures never reach a route handler, so without this the
    // audit trail silently lost exactly the requests users report as "it just failed".
    const errorCode = status >= 500 ? 'SERVER_ERROR' : error.code ?? 'REQUEST_ERROR';
    const requestId = String(request.id);
    if (request.routeOptions?.url !== '/v1/chat/completions') {
      auditRejectedRequest({
        requestId,
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        clientAddress: request.ip,
        statusCode: status,
        errorCode,
        errorMessage: error.message,
      });
    } else {
      completeRequestAudit({
        requestId,
        status: 'error',
        statusCode: status,
        errorCode,
        errorMessage: error.message,
        durationMs: Math.round(reply.elapsedTime || 0),
      });
    }

    reply.status(status).send({
      error: {
        message: redactSecrets(error.message) || 'Internal server error',
        type: status === 500 ? 'server_error' : 'request_error',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    auditRejectedRequest({
      requestId: String(request.id),
      route: request.url,
      method: request.method,
      clientAddress: request.ip,
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      errorMessage: `Route ${request.method}:${request.url} not found`,
    });
    reply.status(404).send({
      error: {
        message: `Route ${request.method}:${request.url} not found`,
        type: 'not_found',
      },
    });
  });
}
