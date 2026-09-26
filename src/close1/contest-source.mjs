/**
 * Where close-1's rules come from, and the one frozen ContestConfig built from them.
 *
 * Trust order, highest first:
 *   1. the signed launch/seed record          (d-close1-price seq 1, `t: seed`)
 *   2. the referee DID                         (operator-pinned below; see PINNED)
 *   3. the package manifest SHA-256            (named by the seed)
 *   4. the package files                       (checked against that manifest)
 *   5. signed referee posts from that DID      (verifyRefereeMessage)
 *   6. peer messages whose signatures verify
 *   7. our own deterministic replay
 *   8. labelled inference
 *   9. everything else
 *
 * Mutable GitHub `main` is never read at run time. The package lives in
 * vendor/close1-package at the commit the seed's hash matches (66c1da3653,
 * 2026-09-25 09:02Z); if either the files or the seed disagree with PINNED,
 * buildContestConfig throws and nothing may be written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envelopePayload, safeVerify, SEASON } from './protocol.mjs';

/**
 * What the operator pins before trusting anything read from the network.
 *
 * The referee DID is the one assumption here that no signed FLOP Labs record
 * backs: close-call-game.md says FLOP Labs "pins the package manifest hash and
 * the referee DID in the launch record and the seed message", but the seed we
 * found is signed BY the referee and names only the package; no separately
 * signed launch record naming this DID has been found (2026-09-26). The DID is
 * the key that owns all five d-close1-* rooms and ran sonnet-2.
 */
export const PINNED = Object.freeze({
  season: SEASON,
  refereeDid: 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte',
  packageSha256: 'bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa',
  packageCommit: '66c1da3653',
  seedRoom: 'd-close1-price',
  seedSeq: 1
});

export const PACKAGE_DIR = path.resolve('vendor/close1-package');

export class ContestSourceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The package's own scripts/verify.py, in JavaScript: every file's bytes against manifest.json. */
export function verifyPackage(dir, expectedSha) {
  let manifestBytes;
  try { manifestBytes = fs.readFileSync(path.join(dir, 'manifest.json')); } catch {
    throw new ContestSourceError('package_missing', `no manifest.json in ${dir}`);
  }
  const got = sha256(manifestBytes);
  if (got !== expectedSha) throw new ContestSourceError('package_hash', `manifest sha256 ${got} is not the pinned ${expectedSha}`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema_version !== 1 || manifest.package !== 'technocore-close-call') {
    throw new ContestSourceError('package_schema', 'manifest: unsupported schema or package');
  }
  const failures = [];
  for (const [name, rec] of Object.entries(manifest.files || {})) {
    if (name.includes('..') || name.startsWith('/') || name.includes('\\') || rec.url !== name) {
      throw new ContestSourceError('package_schema', `manifest: unsafe path ${name}`);
    }
    let data;
    try { data = fs.readFileSync(path.join(dir, ...name.split('/'))); } catch { failures.push(`${name}: missing`); continue; }
    if (data.length !== rec.bytes || sha256(data) !== rec.sha256) failures.push(`${name}: hash or size mismatch`);
  }
  if (failures.length) throw new ContestSourceError('package_files', failures.join('; '));
  const contest = JSON.parse(fs.readFileSync(path.join(dir, 'contest.json'), 'utf8'));
  return { manifestSha256: got, contest, fileCount: Object.keys(manifest.files).length };
}

/**
 * A referee post, checked cryptographically: the author field names the pinned
 * DID AND the signature over `<room>|<nonce>|<text>` verifies with that DID's
 * key. The `from` field alone is the venue's say-so; the signature is proof.
 */
export function verifyRefereeMessage(msg, room, refereeDid) {
  if (!msg || typeof msg.text !== 'string') return { ok: false, why: 'malformed' };
  if (msg.from !== refereeDid) return { ok: false, why: 'wrong author' };
  if (!safeVerify(envelopePayload(room, msg.nonce, msg.text), msg.sig, refereeDid)) return { ok: false, why: 'signature' };
  let body;
  try { body = JSON.parse(msg.text); } catch { return { ok: false, why: 'not json' }; }
  return { ok: true, body };
}

/** The seed: signed by the referee, naming the pinned package and the contest's referee rooms. */
export function verifySeed(msg, { refereeDid, packageSha256, contest }) {
  const v = verifyRefereeMessage(msg, PINNED.seedRoom, refereeDid);
  if (!v.ok) throw new ContestSourceError('seed_signature', `seed record: ${v.why}`);
  const s = v.body;
  if (s.t !== 'seed' || s.season !== PINNED.season) throw new ContestSourceError('seed_shape', 'seed record is not a close-1 seed');
  if (s.package !== packageSha256) throw new ContestSourceError('seed_package', `seed names package ${s.package}, not ${packageSha256}`);
  const want = [...(contest.rooms?.referee || [])].sort().join(',');
  const have = [...(s.rooms || [])].sort().join(',');
  if (want !== have) throw new ContestSourceError('seed_rooms', `seed rooms ${have} differ from contest.json ${want}`);
  return s;
}

/**
 * Everything a writer may rely on, frozen. Throws ContestSourceError on any
 * mismatch; callers treat that as "no writes this run".
 */
export function buildContestConfig({ seedMsg, packageDir = PACKAGE_DIR, pinned = PINNED }) {
  const pkg = verifyPackage(packageDir, pinned.packageSha256);
  const c = pkg.contest;
  if (c.contest_id !== pinned.season) throw new ContestSourceError('season', `contest.json is ${c.contest_id}`);
  const seed = verifySeed(seedMsg, { refereeDid: pinned.refereeDid, packageSha256: pkg.manifestSha256, contest: c });
  const rooms = Object.freeze({
    trading: Object.freeze([...c.rooms.trading]),
    referee: Object.freeze([...seed.rooms]),
    price: 'd-close1-price', flow: 'd-close1-flow', pnl: 'd-close1-pnl', state: 'd-close1-state', positions: 'd-close1-positions'
  });
  for (const r of ['price', 'flow', 'pnl', 'state', 'positions']) {
    if (!rooms.referee.includes(rooms[r])) throw new ContestSourceError('seed_rooms', `seed does not list ${rooms[r]}`);
  }
  return Object.freeze({
    season: c.contest_id,
    rulesVersion: c.rules_version,
    refereeDid: pinned.refereeDid,
    packageSha256: pkg.manifestSha256,
    packageCommit: pinned.packageCommit,
    rooms,
    firstSweepMs: Date.parse(c.first_sweep),
    sweepMs: c.sweep_seconds * 1000,
    lockSweep: c.lock_sweep,
    mint: Number(c.mint),
    minQty: Number(c.min_qty),
    limitWindow: Number(c.limit_window),
    feeRate: Number(c.fee_rate),
    seed: Object.freeze({ seq: seedMsg.seq, ts: seedMsg.ts, price: seed.price, trade: seed.trade })
  });
}
