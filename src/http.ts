import express from 'express';

export function createApp(ready: () => boolean) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => { response.json({ status: 'ok' }); });
  app.get('/readyz', (_request, response) => {
    const isReady = ready();
    response.status(isReady ? 200 : 503).json({ status: isReady ? 'ready' : 'not_ready' });
  });
  return app;
}
