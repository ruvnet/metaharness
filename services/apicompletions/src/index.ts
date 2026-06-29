// Cloud Run bootstrap (ADR-203 §7.1). Listens on $PORT (8080), long SSE timeouts handled
// by Cloud Run (timeout=300s, concurrency=8).
import { createApp } from './server';
import { loadConfig } from './config';

const config = loadConfig();
const app = createApp();

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`apicompletions listening on :${config.port} (project=${config.projectId})`);
});

// Generous timeout for long-lived SSE streams.
server.timeout = 300_000;

export { app, server, config };
