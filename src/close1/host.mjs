/**
 * Facts about the machine close-1 runs on, for the snapshot and the dashboard.
 * Everything here is read-only and never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readOperatorLock, readWrites } from './operator-lock.mjs';

export const UPDATER_FILE = 'updater-status.json';
export const TELEGRAM_MARKER = 'telegram-online.json';
export const TELEGRAM_TEST_TEXT = 'FLOP Evidence Scout mini PC alerts online';

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };

export function gitHead(repoDir = process.cwd()) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/**
 * Telegram credentials come from the environment, or from a secret env file that already
 * exists on the host. Nothing is created or guessed, and nothing here is ever printed.
 */
export function loadTelegramEnv({ env = process.env, file = path.resolve('.env.local') } = {}) {
  const out = { ...env };
  if (out.TELEGRAM_BOT_TOKEN && out.TELEGRAM_CHAT_ID) return out;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*(.*?)\s*$/);
    if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export const telegramConfigured = (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

/** One test message, once per host; after that only the normal, change-only alerts. */
export async function telegramOnlineTest({ env, dir, fetchFn = fetch, now = new Date() }) {
  if (!telegramConfigured(env)) return { status: 'NOT_CONFIGURED' };
  const marker = path.join(dir, TELEGRAM_MARKER);
  const done = readJson(marker);
  if (done?.sent_at) return { status: 'CONFIGURED', tested_at: done.sent_at };
  try {
    const r = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: TELEGRAM_TEST_TEXT })
    });
    if (!r.ok) return { status: 'CONFIGURED_TEST_FAILED', error: `HTTP ${r.status}` };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ sent_at: now.toISOString() }));
    return { status: 'CONFIGURED', tested_at: now.toISOString() };
  } catch (err) { return { status: 'CONFIGURED_TEST_FAILED', error: String(err.message).slice(0, 120) }; }
}

/** The host block of the snapshot. `prev` supplies last_successful_cycle when this cycle was not one. */
export function hostHealth({ dir, prev = null, nowMs = Date.now(), cycleOk = false, telegram = { status: 'NOT_CONFIGURED' }, baseline, archive = null, writesThisCycle = 0, repoDir = process.cwd() }) {
  const lock = readOperatorLock(dir);
  const writes = readWrites(dir);
  const updater = readJson(path.join(dir, UPDATER_FILE), null);
  const now = new Date(nowMs).toISOString();
  return {
    active_runtime_host: lock.host ?? 'UNKNOWN',
    runtime_commit: gitHead(repoDir),
    operator_mode: lock.mode,
    operator_mode_status: lock.mode_status,
    host_writer: lock.host_writer,
    writes_allowed: lock.writes_allowed,
    writes_blocked_because: lock.reasons,
    evidence_baseline_ready: baseline.ready,
    evidence_status: baseline.status,
    evidence_status_why: baseline.why,
    archive_cache_required: archive?.archive_cache_required ?? null,
    archive_cache_present: archive?.archive_cache_present ?? null,
    archive_cache_valid: archive?.archive_cache_valid ?? false,
    last_close1_cycle: now,
    last_successful_cycle: cycleOk ? now : (prev?.last_successful_cycle ?? null),
    last_write_attempt: writes.last_attempt_at,
    last_actual_write: writes.last_actual_write_at,
    writes_attempted_total: writes.attempts,
    writes_actual_total: writes.actual,
    writes_this_cycle: writesThisCycle,
    telegram_status: telegram.status,
    updater_status: updater?.status ?? 'NOT_RUNNING',
    updater_checked_at: updater?.checked_at ?? null,
    remote_head: updater?.remote_head ?? null,
    active_head: updater?.active_head ?? null
  };
}
