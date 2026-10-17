const pino = require('pino');
const Fastify = require('fastify');
const fs = require('fs');
const log = pino({
  level: 'info',
  transport: { targets: [
    { target: 'pino-roll', options: { file: './logs/probe.log', size: '10m', limit: { count: 2 }, mkdir: true } },
  ] },
});
const app = Fastify({ logger: log, genReqId: (r) => r.headers['x-request-id'] || 'gen-1' });
app.get('/ping', async (req, reply) => { req.log.info('inside handler'); reply.type('text/event-stream'); return 'pong'; });
(async () => {
  const port = 34567;
  await app.listen({ host: '127.0.0.1', port });
  await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: 'Bearer SECRET123', 'x-request-id': 'req_mine' } });
  await app.close();
  await new Promise(r => setTimeout(r, 600));
  const f = fs.readdirSync('./logs').filter(n => n.startsWith('probe'));
  for (const n of f) { console.log('=== ' + n + ' ==='); console.log(fs.readFileSync('./logs/' + n, 'utf8')); if (n.includes('SECRET')) console.log('!!! LEAK'); }
})();
