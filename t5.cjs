const pino = require('pino');
const Fastify = require('fastify');
const fs = require('fs');
const log = pino({
  level: 'info',
  transport: { targets: [
    { target: 'pino-roll', options: { file: './logs/probe.log', size: '10m', limit: { count: 2 }, mkdir: true } },
  ] },
});
const app = Fastify({ loggerInstance: log, genReqId: (r) => r.headers['x-request-id'] || 'gen-1' });
app.get('/ping', async (req, reply) => { req.log.info('inside handler'); reply.type('text/event-stream'); return 'pong'; });
(async () => {
  const port = 34569;
  await app.listen({ host: '127.0.0.1', port });
  log.info('lifecycle: listening');
  await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: 'Bearer SECRET123', 'x-request-id': 'req_mine' } });
  await app.close();
  await new Promise(r => setTimeout(r, 800));
  for (const n of fs.readdirSync('./logs').filter(x => x.startsWith('probe'))) {
    const txt = fs.readFileSync('./logs/' + n, 'utf8');
    console.log('=== ' + n + ' ===');
    console.log(txt);
    if (txt.includes('SECRET')) console.log('!!! SECRET LEAK');
  }
})();
