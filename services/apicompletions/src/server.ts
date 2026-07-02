// Express app factory (ADR-203 §2, §7.1). Mirrors @cognitum-one/api-gateway's Express
// setup; this is the Cloud Run upstream the gateway forwards /v1/* to. SSE-capable
// (no response buffering on the streaming path). Dependency-injected (deps) so tests run
// the full auth → tier → route loop at $0 against a seeded key store + the MockProvider.
import express, { type Express, type Request, type Response } from 'express';
import { type AppDeps, type AppDepsOverrides, defaultDeps } from './deps';
import { makeChatCompletions } from './routes/chatCompletions';
import { makeCompletions } from './routes/completions';
import { makeMessages } from './routes/messages';
import { getModels } from './routes/models';

export function createApp(deps: AppDeps = defaultDeps()): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'apicompletions' });
  });

  app.get('/v1/models', getModels);
  app.post('/v1/chat/completions', makeChatCompletions(deps));
  app.post('/v1/completions', makeCompletions(deps));
  app.post('/v1/messages', makeMessages(deps)); // Anthropic Messages API (ADR-203 §3.6)

  return app;
}

/** Convenience for tests/local: build the app from default deps + targeted overrides. */
export function createAppWith(overrides: AppDepsOverrides): Express {
  return createApp(defaultDeps(overrides));
}
