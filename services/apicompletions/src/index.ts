// Cloud Run bootstrap (ADR-203 §7.1). Listens on $PORT (8080), long SSE timeouts handled
// by Cloud Run (timeout=300s, concurrency=8). Builds the default deps (config + key store
// + provider) once and shares them with the app.
import { createApp } from './server';
import { defaultDeps } from './deps';

const deps = defaultDeps();
const config = deps.config;
const app = createApp(deps);

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `apicompletions listening on :${config.port} (project=${config.projectId}, provider=${deps.provider.name})`,
  );
});

// Generous timeout for long-lived SSE streams.
server.timeout = 300_000;

export { app, server, config };
