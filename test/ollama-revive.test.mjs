import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldReviveOllama, isLoopbackHost, findOllamaBinary, reviveOllama, OLLAMA_REVIVE_COOLDOWN_MS
} from '../src/inference-backends.mjs';

/**
 * Ollama died at 12:44 on 2026-09-02 and the agent generated nothing for four
 * hours, degrading exactly as designed and telling nobody who was listening.
 * The revive is bounded on purpose: only a local host, at most every ten
 * minutes, never waited on.
 */
describe('Reviving a dead local Ollama', () => {
  test('only a loopback host is ours to start', () => {
    assert.equal(isLoopbackHost('http://127.0.0.1:11434'), true);
    assert.equal(isLoopbackHost('http://localhost:11434'), true);
    assert.equal(isLoopbackHost('http://10.0.0.7:11434'), false, 'somebody else\'s server');
    assert.equal(isLoopbackHost('not a url'), false);
    assert.equal(shouldReviveOllama({ host: 'http://gpu-box.lan:11434' }).revive, false);
  });

  test('a fresh attempt inside the cooldown is refused', () => {
    // Startup on this machine hung requests for ~50 s before answering in 4 ms.
    // A second spawn inside that window fights the first for the port.
    const t0 = 1_000_000;
    assert.equal(shouldReviveOllama({ lastAttemptAt: 0, now: t0 }).revive, true);
    const early = shouldReviveOllama({ lastAttemptAt: t0, now: t0 + OLLAMA_REVIVE_COOLDOWN_MS - 1 });
    assert.equal(early.revive, false);
    assert.equal(early.reason, 'cooldown');
    assert.equal(shouldReviveOllama({ lastAttemptAt: t0, now: t0 + OLLAMA_REVIVE_COOLDOWN_MS }).revive, true);
  });

  test('the binary is OLLAMA_BIN, then the Windows install, then PATH', () => {
    const exists = (p) => p === 'C:\\custom\\ollama.exe' || p === 'C:\\Users\\x\\AppData\\Local\\Programs\\Ollama\\ollama.exe';
    assert.equal(findOllamaBinary({ env: { OLLAMA_BIN: 'C:\\custom\\ollama.exe' }, platform: 'win32', exists }), 'C:\\custom\\ollama.exe');
    assert.equal(findOllamaBinary({ env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, platform: 'win32', exists }),
      'C:\\Users\\x\\AppData\\Local\\Programs\\Ollama\\ollama.exe');
    assert.equal(findOllamaBinary({ env: {}, platform: 'linux', exists: () => false }), 'ollama');
  });

  test('a binary that is not there does not take the daemon down with it', async () => {
    // spawn reports ENOENT on the child, asynchronously, not by throwing. An
    // 'error' with no listener is an uncaught exception; this is a Linux runner
    // with no ollama, which is where it was found.
    const handlers = {};
    const spawnFn = () => ({
      on(event, fn) { handlers[event] = fn; },
      unref() {}
    });
    const state = { lastAttemptAt: 0 };

    const result = await reviveOllama({
      host: 'http://127.0.0.1:11434', state, now: () => 5_000_000, spawnFn, binary: 'ollama'
    });

    assert.equal(result.attempted, true, 'we did try');
    assert.equal(typeof handlers.error, 'function', 'and something is listening for the failure');
    assert.doesNotThrow(() => handlers.error(Object.assign(new Error('spawn ollama ENOENT'), { code: 'ENOENT' })));
  });

  test('a revive spawns once, detached, and then respects the cooldown', async () => {
    const calls = [];
    const spawnFn = (bin, args, opts) => { calls.push({ bin, args, opts }); return { unref() { calls.push('unref'); } }; };
    const state = { lastAttemptAt: 0 };
    let clock = 5_000_000;

    const first = await reviveOllama({ host: 'http://127.0.0.1:11434', state, now: () => clock, spawnFn, binary: 'ollama' });
    assert.equal(first.attempted, true);
    assert.deepEqual(calls[0].args, ['serve']);
    assert.equal(calls[0].opts.detached, true, 'the cycle must not wait on it');
    assert.equal(calls[0].opts.stdio, 'ignore');
    assert.equal(calls[1], 'unref', 'a daemon restart must not take it down');

    clock += 60_000;
    const second = await reviveOllama({ host: 'http://127.0.0.1:11434', state, now: () => clock, spawnFn, binary: 'ollama' });
    assert.equal(second.attempted, false);
    assert.equal(second.reason, 'cooldown');
    assert.equal(calls.length, 2, 'no second spawn inside the window');
  });

  test('a spawn failure is reported and never thrown into the cycle', async () => {
    const state = { lastAttemptAt: 0 };
    const result = await reviveOllama({
      host: 'http://127.0.0.1:11434', state, now: () => 9_000_000,
      spawnFn: () => { throw new Error('ENOENT'); }, binary: 'ollama'
    });
    assert.equal(result.attempted, false);
    assert.match(result.reason, /ENOENT/);
  });

  test('a remote host is never spawned, whatever the cooldown says', async () => {
    let spawned = 0;
    const result = await reviveOllama({
      host: 'http://10.0.0.7:11434', state: { lastAttemptAt: 0 }, now: () => 9_000_000,
      spawnFn: () => { spawned += 1; return { unref() {} }; }, binary: 'ollama'
    });
    assert.equal(result.attempted, false);
    assert.equal(spawned, 0);
  });
});
