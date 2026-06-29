// Express app factory (ADR-203 §2, §7.1). Mirrors @cognitum-one/api-gateway's Express
// setup; this is the Cloud Run upstream the gateway forwards /v1/* to. SSE-capable
// (no response buffering on the streaming path).
import express, { type Express, type Request, type Response } from 'express';
import { postChatCompletions } from './routes/chatCompletions';
import { postCompletions } from './routes/completions';
import { getModels } from './routes/models';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'apicompletions' });
  });

  app.get('/v1/models', getModels);
  app.post('/v1/chat/completions', postChatCompletions);
  app.post('/v1/completions', postCompletions);

  return app;
}
