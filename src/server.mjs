import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTriAgentServer } from './app.mjs';
import { createLocalProviders } from './adapters/providers.mjs';
import { LearningRegistry } from './core/learning-registry.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number.parseInt(process.env.TRIAGENT_PORT ?? '4317', 10);
const host = '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('TRIAGENT_PORT must be an integer from 1 to 65535');
}

const server = createTriAgentServer({
  dataRoot: path.join(projectRoot, 'data', 'runs'),
  webRoot: path.join(projectRoot, 'web'),
  workspace: projectRoot,
  liveProviders: createLocalProviders({
    workspace: projectRoot,
    timeoutMs: Number.parseInt(process.env.TRIAGENT_PROVIDER_TIMEOUT_MS ?? '240000', 10)
  }),
  learningRegistry: new LearningRegistry({ root: path.join(projectRoot, 'data', 'learning') })
});

server.listen(port, host, () => {
  console.log(`TriAgent listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
