import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function registerCommonMiddleware(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.log.debug({ url: request.url, method: request.method }, 'incoming request');
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const responseTime = reply.elapsedTime;
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

  app.setErrorHandler((error, request, reply) => {
    reply.status(error.statusCode || 500).send({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        message: `Route ${request.method}:${request.url} not found`,
        type: 'not_found',
      },
    });
  });
}
