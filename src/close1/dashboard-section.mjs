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

export function renderClose1Section(s) {
  if (!s) return '';
  const c = s.flow_counts;
  const gate = s.gate || {};
  const conf = s.evidence_confidence || {};
  const last = s.latest_trade;
  const offers = (s.open_offers || []).map((o) => `${esc(o.id)}: ${esc(o.side)} ${esc(o.qty)} @ ${esc(o.px)} until sweep ${esc(o.until)}`).join('<br>') || 'none';
  const rows = (s.trades || []).slice(-8).reverse().map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.status)}${t.void_reason ? ` (${esc(t.void_reason)})` : ''}</td><td>${esc(t.evidence)}</td><td>${esc(t.ownership)}</td></tr>`).join('');
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
        <div class="sub">price post ${age(s.price_post_age_seconds)} old · ref trade ${age(s.reference_age_seconds)} old · ref ${esc(s.reference_price)}</div>
      </div>
      <div class="card">
        <h3>Gate</h3>
        <div class="val" style="font-size:1.1rem;color:${GATE_COLOR[gate.kind] || '#94a3b8'}">${esc(gate.kind ?? '?')}</div>
        <div class="sub">${gate.ok ? 'writes allowed' : esc((gate.reasons || []).join(', '))}</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:24px;font-size:0.85rem;line-height:1.6">
      <div>🔏 <strong>Contest:</strong> ${verified} · owner <strong>${esc(s.owner_state)}</strong> (${esc(s.owner_evidence)}${conf.owner_assumption ? `, assumes ${esc(conf.owner_assumption)}` : ''})</div>
      <div>📊 <strong>Flow ${esc(c?.n ?? '?')}:</strong> listed settled ${esc(c?.listed.settled)} / void ${esc(c?.listed.void)} / mints ${esc(c?.listed.mints)} · <strong>omitted</strong> settled ${esc(c?.omitted.settled)} / void ${esc(c?.omitted.void)} / mints ${esc(c?.omitted.mints)}${c?.missed ? ` · missed ranges ${esc(c.missed)}` : ''} — an empty list is not an empty sweep</div>
      <div>🧾 <strong>Evidence confidence:</strong> ${esc(conf.overall)} · position ${esc(conf.position)} · settlements proven ours ${esc(s.settled_proven_count)}, id-only ${esc(s.id_settled_count)}</div>
      <div>🟢 <strong>Open offers:</strong> ${offers}</div>
      <div>🕒 <strong>Latest trade:</strong> ${last ? `<code>${esc(last.id)}</code> ${esc(last.status)} · ${esc(last.evidence)} · ownership ${esc(last.ownership)}` : 'none'}</div>
      ${rows ? `<table style="width:100%;margin-top:10px;font-size:0.8rem"><thead><tr><th align="left">trade</th><th align="left">status</th><th align="left">evidence</th><th align="left">ours?</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      <div style="color:var(--text-muted);margin-top:8px">Snapshot ${esc(s.generated_at)}. "ID_SETTLED" means the referee settled that trade id — not that the settling copy was ours.</div>
    </div>`;
}
