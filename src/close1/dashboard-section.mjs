/**
 * The close-1 block of the status dashboard, rendered from runtime.json.
 *
 * It shows what we can prove and, separately, what is only possible: a proven
 * position next to the range the unproven trades allow, a balance only when
 * it is provable, and the referee's listed-versus-omitted counts so an empty
 * list is never read as a quiet sweep.
 */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const age = (s) => (s == null ? '?' : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);

const GATE_COLOR = { open: '#34d399', hold: '#fbbf24', halt: '#f87171' };
const ARCHIVE_COLOR = { CURRENT: '#34d399', LAGGING: '#fbbf24', UNAVAILABLE: '#f87171' };

/** The board row is display order; a place is shown only when the whole tie is visible. */
function standingLine(s) {
  if (!s.leaderboard_display_row) return `not visible in truncated top list (${esc(s.leaderboard_rows_visible ?? 0)} rows shown) · place unknown`;
  const tie = `score ${esc(s.official_score)} · display row ${esc(s.leaderboard_display_row)} (DID order, not a rank) · tie of ${esc(s.tie_visible_count)} visible`;
  if (!s.tie_complete) return `${tie}, <strong>tie may extend beyond visible list</strong> · prize place UNKNOWN`;
  const places = (s.prize_places || []).length ? `places ${esc(s.prize_places.join(', '))} shared by ${esc(s.prize_sharing)}` : 'no prize place';
  return `${tie}, complete · ${places} (${esc(s.prize_confidence)}: live mark, not final)`;
}

/** Which machine runs close-1, under what lock, and what it has actually written. */
function hostLine(s) {
  if (s.active_runtime_host === undefined) return '';
  const evidence = s.evidence_baseline_ready === false ? `<strong>BACKFILLING</strong> (${esc(s.evidence_status_why ?? '')}) — evidence alerts held` : 'baseline ready';
  const cache = s.archive_cache_required != null ? `archive cache ${esc(s.archive_cache_present)}/${esc(s.archive_cache_required)} (${s.archive_cache_valid ? 'valid' : 'incomplete'})` : 'archive cache ?';
  return `<div>🖥 <strong>Runtime host:</strong> ${esc(s.active_runtime_host)} · commit ${esc(String(s.runtime_commit ?? '?').slice(0, 7))} · operator <strong>${esc(s.operator_mode ?? s.operator_mode_status)}</strong> · writes allowed ${esc(s.writes_allowed)} · last write attempt ${esc(s.last_write_attempt ?? 'never')}, last actual write ${esc(s.last_actual_write ?? 'never')} (total ${esc(s.writes_actual_total ?? 0)})</div>
      <div>🧭 <strong>Evidence:</strong> ${evidence} · ${cache} · telegram ${esc(s.telegram_status)} · updater ${esc(s.updater_status)} (remote ${esc(String(s.remote_head ?? '?').slice(0, 7))}, active ${esc(String(s.active_head ?? '?').slice(0, 7))}) · last cycle ${esc(s.last_close1_cycle ?? '?')}, last successful ${esc(s.last_successful_cycle ?? 'never')}</div>`;
}

/** The corroborated account, fenced off: it is never what the gate reads. */
function corroboratedBlock(s) {
  const c = s.corroborated_account;
  if (!c) return '';
  const cmp = s.account_comparison || {};
  const conflicts = (cmp.conflicts || []).map((x) => `<span style="color:#f87171">${esc(x.detail)}</span>`).join('; ');
  return `<div>🧮 <strong>Corroborated account</strong> <em>(${esc(c.label)})</em>: position ${esc(c.net_position)} (still unknown: ${esc(c.unknown_range.low)} … ${esc(c.unknown_range.high)}), cash ${esc(c.cash)}, fees ${esc(c.fees)}, avg entry ${esc(c.average_entry ?? '—')}, score at reference ${esc(c.score_at?.reference?.score ?? '?')}${conflicts ? ` · CONFLICT: ${conflicts}` : ''}</div>`;
}

function archiveLine(a) {
  if (!a) return 'not checked yet';
  const lag = a.archive_lag_sweeps != null ? ` · ${esc(a.archive_lag_sweeps)} sweeps (~${esc(a.archive_lag_minutes)} min) behind the referee (${esc(a.live_latest_sweep)})${a.archive_index_last_modified ? ` · index last modified ${esc(a.archive_index_last_modified)}` : ''}` : '';
  const cls = Object.entries(a.records_by_class || {}).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ') || 'none';
  return `<span style="color:${ARCHIVE_COLOR[a.archive_status] || '#94a3b8'}">${esc(a.archive_status)}</span> · ends at sweep ${esc(a.archive_latest_sweep ?? '?')}${lag}`
    + ` · our sweeps checked ${esc(a.checked_sweeps ?? 0)}/${esc(a.needed_sweeps ?? 0)} (${cls})${a.mismatch_sweeps?.length ? ` · <span style="color:#f87171">hash mismatch at ${esc(a.mismatch_sweeps.join(', '))}</span>` : ''}`;
}

export function renderClose1Section(s) {
  if (!s) return '';
  const c = s.flow_counts;
  const gate = s.gate || {};
  const conf = s.evidence_confidence || {};
  const last = s.latest_trade;
  const offers = (s.open_offers || []).map((o) => `${esc(o.id)}: ${esc(o.side)} ${esc(o.qty)} @ ${esc(o.px)} until sweep ${esc(o.until)}`).join('<br>') || 'none';
  const hint = (t) => (t.archive_observations || []).map((o) => `${esc(o.outcome)}@${esc(o.sweep)}${o.our_copy ? ' (our copy)' : ''}`).join(', ');
  const rows = (s.trades || []).slice(-8).reverse().map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.status)}${t.void_reason ? ` (${esc(t.void_reason)})` : ''}</td><td>${esc(t.evidence)}</td><td>${esc(t.ownership)}</td><td>${hint(t) ? `<span title="redacted record: not proof">${hint(t)} ⚠︎</span>` : ''}</td></tr>`).join('');
  const verified = s.contest_verified
    ? `<span style="color:#34d399">verified</span> · package <code>${esc(String(s.package_sha256).slice(0, 12))}…</code>`
    : `<span style="color:#f87171">NOT VERIFIED</span> — ${esc(s.contest_error)}`;
  return `
    <h2 class="section-title">📈 close-1 (NVDA) — what we can prove</h2>
    <div class="grid">
      <div class="card">
        <h3>Proven position</h3>
        <div class="val">${esc(s.proven_position ?? '?')}</div>
        <div class="sub">possible range ${esc(s.exposure_low)} … ${esc(s.exposure_high)} contracts</div>
      </div>
      <div class="card">
        <h3>POLF balance</h3>
        <div class="val" style="font-size:1.1rem">${s.balance_provable ? esc(s.polf_balance) : 'not provable'}</div>
        <div class="sub">${s.balance_provable ? 'official mint, every trade resolved' : `worst-case free ${esc(s.free_polf_worst_case)}`}</div>
      </div>
      <div class="card">
        <h3>Referee</h3>
        <div class="val" style="font-size:1.1rem">sweep ${esc(s.current_sweep ?? '?')}</div>
        <div class="sub">price post ${age(s.price_post_age_seconds)} old · ref trade ${age(s.reference_age_seconds)} old${s.reference_warning ? ' (old trade; still the published reference, rule 11)' : ''} · ref ${esc(s.reference_price)}</div>
      </div>
      <div class="card">
        <h3>Gate</h3>
        <div class="val" style="font-size:1.1rem;color:${GATE_COLOR[gate.kind] || '#94a3b8'}">${esc(gate.kind ?? '?')}</div>
        <div class="sub">${gate.ok ? 'writes allowed' : esc((gate.reasons || []).join(', '))}</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:24px;font-size:0.85rem;line-height:1.6">
      <div>🔏 <strong>Contest:</strong> ${verified} · owner <strong>${esc(s.owner_state)}</strong> (${esc(s.owner_evidence)}${conf.owner_assumption ? `, assumes ${esc(conf.owner_assumption)}` : ''}) · confidence <strong>${esc(s.owner_confidence ?? '?')}</strong>${(s.owner_evidence_sources || []).length ? ` [${(s.owner_evidence_sources || []).map((x) => esc(x.evidence)).join(', ')}]` : ''}</div>
      <div>📊 <strong>Flow ${esc(c?.n ?? '?')}:</strong> listed settled ${esc(c?.listed.settled)} / void ${esc(c?.listed.void)} / mints ${esc(c?.listed.mints)} · <strong>omitted</strong> settled ${esc(c?.omitted.settled)} / void ${esc(c?.omitted.void)} / mints ${esc(c?.omitted.mints)}${c?.missed ? ` · missed ranges ${esc(c.missed)}` : ''} — an empty list is not an empty sweep</div>
      <div>🧾 <strong>Evidence confidence:</strong> ${esc(conf.overall)} · position ${esc(conf.position)} · settlements proven ours ${esc(s.settled_proven_count)}, id-only ${esc(s.id_settled_count)}</div>
      <div>🏁 <strong>Board:</strong> ${standingLine(s)}</div>
      <div>🗄️ <strong>Official archive:</strong> ${archiveLine(s.archive)} — only REFEREE_HASH_VERIFIED_FULL may change a status; OFFICIAL_INDEX_VERIFIED_REDACTED corroborates, never proves</div>
      ${hostLine(s)}
      <div>🐙 <strong>GitHub watcher:</strong> ${esc(s.github_watch_status ?? '?')} · remaining ${esc(s.github_remaining ?? '?')} · resets ${esc(s.github_reset_at ?? '?')} · last success ${esc(s.github_last_success ?? 'never')}${s.github_authenticated ? '' : ' · no token'}</div>
      ${corroboratedBlock(s)}
      <div>🟢 <strong>Open offers:</strong> ${offers}</div>
      <div>🕒 <strong>Latest trade:</strong> ${last ? `<code>${esc(last.id)}</code> ${esc(last.status)} · ${esc(last.evidence)} · ownership ${esc(last.ownership)}` : 'none'}</div>
      ${rows ? `<table style="width:100%;margin-top:10px;font-size:0.8rem"><thead><tr><th align="left">trade</th><th align="left">status</th><th align="left">evidence</th><th align="left">ours?</th><th align="left">archive (unverified)</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      <div style="color:var(--text-muted);margin-top:8px">Snapshot ${esc(s.generated_at)}. "ID_SETTLED" means the referee settled that trade id — not that the settling copy was ours.</div>
    </div>`;
}
