/**
 * Where inference actually runs.
 *
 * Three backends, in increasing order of how much they prove:
 *
 *   simulated   Runs no model. Exists so the pipeline, the receipts and the tests
 *               work on a machine with nothing installed, and on CI. Every receipt
 *               it produces is stamped simulated:true and can never count as work.
 *
 *   ollama      A real local model over Ollama's HTTP API. Zero dependencies —
 *               it is a plain fetch to 127.0.0.1. This is the one that makes the
 *               agent an actual inference consumer today.
 *
 *   flopSession A placeholder for the real thing. It refuses, loudly, with the
 *               reason. No Flop endpoint exists: auth.md says plainly there is no
 *               registration, provisioning, claim or token endpoint at any path,
 *               and asks that nobody probe for one. When a session route is
 *               published this is the only file that needs to change.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/**
 * A deterministic stand-in. NOT inference.
 *
 * It returns a stable digest-derived string so hashes and counts flow through the
 * pipeline unchanged between runs. It is deliberately unhelpful as text: nothing
 * should ever be tempted to publish its output.
 */
export const simulatedBackend = {
  id: 'simulated',
  simulated: true,
  available: async () => true,
  async generate({ prompt }) {
    const crypto = await import('node:crypto');
    const digest = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
    return {
      text: `[simulated backend — no model was run] ${digest.slice(0, 32)}`,
      modelId: 'simulated',
      parameters: null
    };
  }
};

/**
 * A real model, running locally, over Ollama's HTTP API.
 *
 * Ollama is not bundled and is not installed by this project — it is a separate
 * download the operator makes deliberately. Everything here degrades to
 * "unavailable" if it is not running, and nothing in the codebase requires it.
 *
 * On a 6 GB card a 3B model at 4-bit quantisation is comfortable and a 7B is
 * tight; the operator picks. The model identifier carries its own parameter count
 * (\`qwen2.5:3b\`), which is what the FLOPs estimate reads.
 */
export function ollamaBackend({ model = process.env.OLLAMA_MODEL || 'qwen2.5:3b', host = OLLAMA_HOST, timeoutMs = 120_000 } = {}) {
  return {
    id: 'ollama',
    simulated: false,
    model,
    host,

    async available() {
      try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return false;
        const body = await res.json();
        const names = (body.models || []).map((m) => m.name);
        // An Ollama that is running but has no model pulled cannot serve.
        return names.length > 0 && (names.includes(model) || names.some((n) => n.startsWith(`${model.split(':')[0]}:`)));
      } catch {
        return false;
      }
    },

    async listModels() {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`ollama /api/tags returned ${res.status}`);
      return ((await res.json()).models || []).map((m) => ({ name: m.name, sizeBytes: m.size }));
    },

    async generate({ prompt, request }) {
      const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: {
            // Bounded output. A model fed untrusted text must not be able to
            // produce an unbounded response, and every downstream consumer here
            // has a length cap anyway.
            num_predict: 512,
            temperature: 0.2
          }
        }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, (request?.maxLatencyMs ?? timeoutMs) * 2))
      });
      if (!res.ok) throw new Error(`ollama /api/generate returned ${res.status}`);
      const body = await res.json();

      return {
        text: body.response ?? '',
        modelId: body.model ?? model,
        // Ollama reports exact token counts, so the four-chars-a-token estimate
        // is only a fallback for backends that do not.
        promptTokens: body.prompt_eval_count,
        completionTokens: body.eval_count,
        parameters: null,
        raw: {
          totalDurationNs: body.total_duration,
          evalDurationNs: body.eval_duration,
          loadDurationNs: body.load_duration
        }
      };
    }
  };
}

/**
 * The real thing, when it exists.
 *
 * Kept as an explicit refusal rather than an absence, so the shape of the switch
 * is visible and the reason for the refusal is stated where someone will read it.
 */
export const flopSessionBackend = {
  id: 'flop-session',
  simulated: false,
  available: async () => false,
  async generate() {
    throw new Error(
      'No Flop inference endpoint exists. The teaser puts testnet in Q4 2026 and no session '
      + 'route is published in technocore.chat/openapi.json. auth.md asks that nobody probe for '
      + 'unpublished paths, so this backend waits for the route to be documented rather than guessing it.'
    );
  }
};

/**
 * Pick the best backend actually available, preferring real inference.
 *
 * Falls back to the simulated backend so nothing breaks on a bare machine — and
 * says which one it chose, because that difference matters more than anything
 * else in this file.
 */
export async function selectBackend({ preferred = null, model } = {}) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  candidates.push(flopSessionBackend, ollamaBackend({ ...(model ? { model } : {}) }), simulatedBackend);

  for (const backend of candidates) {
    if (await backend.available()) {
      return { backend, real: backend.simulated !== true };
    }
  }
  return { backend: simulatedBackend, real: false };
}
