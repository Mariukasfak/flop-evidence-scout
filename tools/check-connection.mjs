// TriAgent ryšio patikra. Trečia dalis paleidžia po vieną tikrą kiekvieno
// agento proposal užklausą ir todėl naudoja Codex, Claude bei Gemini kvotas.

import { fileURLToPath } from 'node:url';

import { createLocalProviders, discoverExecutables } from '../src/adapters/providers.mjs';
import { buildProposalPrompt } from '../src/core/council.mjs';

const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const PROVIDER_TIMEOUT_MS = 240_000;

console.log('=== 1. Ar randame vietinius agentų transportus ===');
const executables = discoverExecutables();
for (const [id, filePath] of Object.entries(executables)) {
  console.log(`  ${id.padEnd(7)} ${filePath ? 'rasta' : 'NERASTA'}`);
}

console.log('\n=== 2. Ar tie patys TriAgent provider adapteriai pasileidžia ===');
const providers = createLocalProviders({
  workspace: WORKSPACE,
  executables,
  timeoutMs: PROVIDER_TIMEOUT_MS
});
const healthById = new Map();
for (const provider of providers) {
  const health = await provider.health();
  healthById.set(provider.id, health);
  const mark = health.councilAvailable ? 'taryba veikia' : 'NEVEIKIA';
  const detail = health.version ?? health.reason ?? '';
  console.log(`  ${provider.id.padEnd(7)} ${mark.padEnd(14)} ${detail}`);
}

console.log('\n=== 3. Ar visi trys realiai grąžina struktūruotą tarybos atsakymą ===');
const context = JSON.stringify({
  schemaVersion: 1,
  task: 'Prisijungimo patikra. Atsakyk trumpai lietuviškai.',
  constraint: 'Tik nuomonė; nenaudok kompiuterio įrankių.'
});

const results = await Promise.all(providers.map(async (provider) => {
  const health = healthById.get(provider.id);
  if (!health?.councilAvailable) {
    return { id: provider.id, ok: false, detail: health?.reason ?? 'live taryba nepasiekiama' };
  }
  const started = Date.now();
  try {
    const response = await provider.generate({
      phase: 'proposal',
      prompt: buildProposalPrompt(context, provider.id),
      contextCheckpoint: context,
      runId: `connection-${Date.now()}-${provider.id}`
    });
    if (typeof response?.summary !== 'string' || !response.summary.trim()) {
      throw new Error('grąžintas atsakymas neturi summary');
    }
    return {
      id: provider.id,
      ok: true,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      summary: response.summary
    };
  } catch (error) {
    return {
      id: provider.id,
      ok: false,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      detail: error.message
    };
  }
}));

for (const result of results) {
  if (result.ok) {
    console.log(`  ${result.id.padEnd(7)} PAVYKO per ${result.seconds}s · ${result.summary}`);
  } else {
    console.log(`  ${result.id.padEnd(7)} NEPAVYKO${result.seconds ? ` per ${result.seconds}s` : ''} · ${result.detail}`);
  }
}

const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.log(`\nPatikra dalinė: ${results.length - failed.length}/${results.length} agentų atsakė realiai.`);
  if (failed.some((result) => result.id === 'claude')) {
    console.log('Jei Claude mini OAuth, paleiskite claude ir įveskite /login.');
  }
  if (failed.some((result) => result.id === 'gemini')) {
    console.log('Jei Gemini nepasiekiamas, paleiskite Antigravity ir palikite TriAgent projektą prijungtą.');
  }
  process.exitCode = 1;
} else {
  console.log('\nPAVYKO: Codex, Claude ir Gemini prijungti prie tos pačios live tarybos.');
}
