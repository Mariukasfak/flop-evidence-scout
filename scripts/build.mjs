import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'src/adapters/command.mjs',
  'src/adapters/providers.mjs',
  'src/app.mjs',
  'src/core/contracts.mjs',
  'src/core/council.mjs',
  'src/core/run-store.mjs',
  'src/orchestrator.mjs',
  'src/server.mjs',
  'src/agents/flop-scout/identity.mjs',
  'src/agents/flop-scout/knowledge.mjs',
  'src/agents/flop-scout/guardrails.mjs',
  'src/agents/flop-scout/technocore-client.mjs',
  'src/agents/flop-scout/scout-engine.mjs',
  'src/agents/flop-scout/daemon.mjs',
  'src/agents/flop-scout/monitor.mjs',
  'web/app.js'
];

for (const relativePath of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', relativePath], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

const webRoot = path.join(projectRoot, 'web');
for (const required of ['index.html', 'styles.css', 'app.js']) {
  if (!fs.existsSync(path.join(webRoot, required))) {
    throw new Error(`Missing web asset: ${required}`);
  }
}

const distRoot = path.join(projectRoot, 'dist');
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });
fs.cpSync(webRoot, path.join(distRoot, 'web'), { recursive: true });

console.log(`Build complete: ${sourceFiles.length} scripts checked, web assets copied to dist/web.`);
