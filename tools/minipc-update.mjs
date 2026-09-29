#!/usr/bin/env node
/**
 * The mini PC's safe deployer (see src/close1/updater.mjs). Scheduled every 20
 * minutes; exit code 0 unless the update was blocked by something a person must look at.
 *
 *   node tools/minipc-update.mjs
 */
import path from 'node:path';
import { runUpdate, STATUS } from '../src/close1/updater.mjs';
import { deliverAlerts } from '../src/close1/runtime.mjs';
import { loadTelegramEnv } from '../src/close1/host.mjs';

const dir = path.resolve('data/local/close1');
const out = await runUpdate({
  repoDir: process.cwd(), dir,
  notify: (a) => deliverAlerts([a], { logFile: path.join(dir, 'alerts.jsonl'), env: loadTelegramEnv() })
});
console.log(`${out.checked_at} ${out.status}${out.detail ? ` — ${out.detail}` : ''} (active ${String(out.active_head).slice(0, 7)}, remote ${String(out.remote_head).slice(0, 7)})`);
if (out.tests_tail) console.log(out.tests_tail);
process.exitCode = [STATUS.BLOCKED_TESTS_FAILED, STATUS.BLOCKED_ERROR, STATUS.BLOCKED_OPERATOR_LOCK].includes(out.status) ? 2 : 0;
