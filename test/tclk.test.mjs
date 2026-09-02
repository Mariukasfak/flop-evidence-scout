import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  OFFER_ROOM, TCLK_DOMAIN, canonicalJson, toAscii, offerId, contractId,
  dealRoom, statePointer, generateHashLock, statementFor, opensStatement,
  encodeFrame, decodeFrame, validateDeadlines, applyFrame, openContract,
  railToken, railsFromNote, isContractId
} from '../src/tclk.mjs';

/**
 * The offer frame from the official walkthrough, verbatim.
 *
 * Its ids are hand-written placeholders — the "contract id" is a rotation of
 * the offer id, and the accept frame's statement is 63 hex characters — so this
 * is not a test vector and cannot check our hashing. What it does check is the
 * part that decides whether two implementations agree at all: field order,
 * separators, and nested-object ordering coming out of a canonical encoder.
 */
const OFFICIAL_OFFER_LINE = 'tclk1 {"amount":"250000","asset":"FLOP","claimByMs":1757300000000,'
  + '"expiresMs":1757213600000,"from":"did:key:z6MkPayerExampleDid1111111111111111111",'
  + '"id":"0x7a1ec7e2d9b6a4f3c8e1a05d92f7b6c1e4a8d0f3b6c9e2a5d8f1b4c7e0a3d6f9",'
  + '"job":{"id":"task-42","proto":"a2a"},"lock":"hash","nonce":"9f2c81d04c9e1f7a",'
  + '"rails":["flop-htlc"],"refundAfterMs":1757386400000,"role":"payer","type":"offer"}';

const PAYER = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const PAYEE = 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
const STRANGER = 'did:key:z6MknDn3CH7vumHw5rXREhdQaBcDeFgHiJkLmNoPqRsTuVwX';

const anOffer = (over = {}) => ({
  amount: '1000', asset: 'FLOP', claimByMs: 2_000_000, expiresMs: 1_500_000,
  from: PAYER, lock: 'hash', nonce: 'abc123', rails: ['paper'],
  refundAfterMs: 3_000_000, role: 'payer', type: 'offer', ...over
});

describe('tclk canonical encoding', () => {
  test('the official example re-encodes byte for byte', () => {
    // If our key ordering or separators differed by one character, every id we
    // computed would differ from theirs and both sides would think they were on
    // different deals. This is the closest thing to a shared fixture that the
    // repository publishes.
    const payload = JSON.parse(OFFICIAL_OFFER_LINE.slice('tclk1 '.length));
    assert.equal('tclk1 ' + toAscii(canonicalJson(payload)), OFFICIAL_OFFER_LINE);
  });

  test('and our decoder still refuses it, because its DID is a placeholder', () => {
    // `did:key:z6MkPayerExampleDid1111111111111111111` is 34 characters after
    // the z6Mk prefix where a real Ed25519 did:key has 44. The walkthrough is
    // illustrative — its statement is 63 hex characters too — so it is a shape
    // to match, never a vector to verify hashes against. Fail-closed means
    // refusing a frame we cannot attribute, including a famous one.
    assert.equal(decodeFrame(OFFICIAL_OFFER_LINE), null);
  });

  test('keys sort, undefined drops, nested objects sort too', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson({ z: { proto: 'a2a', id: 'x' } }), '{"z":{"id":"x","proto":"a2a"}}');
    assert.equal(canonicalJson([3, 1]), '[3,1]', 'array order is data, not formatting');
  });

  test('non-ASCII is escaped and ASCII is untouched', () => {
    assert.equal(toAscii('plain ascii'), 'plain ascii');
    assert.equal(toAscii('ė'), '\\u0117');
    // The reason it matters: the venue sweeps and stores code points, and our
    // signature covers what is stored. Escaping first makes the two identical.
    assert.equal(toAscii('a b'), 'a\\u2028b');
  });

  test('an id commits to the escaped bytes, so a non-ASCII field cannot fork it', () => {
    const withUnicode = anOffer({ job: { id: 'užduotis', proto: 'a2a' } });
    const id = offerId(withUnicode);
    assert.match(id, /^0x[0-9a-f]{64}$/);
    // Recomputing from the decoded wire form must give the same id.
    const wire = decodeFrame(encodeFrame({ ...withUnicode, id }));
    assert.equal(offerId(wire), id);
  });

  test('the offer id ignores the id field itself', () => {
    const fields = anOffer();
    const id = offerId(fields);
    assert.equal(offerId({ ...fields, id }), id);
    assert.equal(offerId({ ...fields, id: '0x' + '9'.repeat(64) }), id);
  });

  test('changing any term changes the contract id', () => {
    const offer = { ...anOffer(), id: offerId(anOffer()) };
    const core = { from: PAYEE, ref: offer.id, statement: statementFor(`0x${'11'.repeat(32)}`), nonce: 'n1' };
    const base = contractId(offer, core);

    assert.equal(contractId(offer, core), base, 'and it is stable');
    assert.notEqual(contractId({ ...offer, amount: '1001' }, core), base);
    assert.notEqual(contractId(offer, { ...core, nonce: 'n2' }), base);
    assert.notEqual(contractId(offer, { ...core, from: STRANGER }), base);
  });
});

describe('tclk hash locks', () => {
  test('a minted lock opens its own statement and nothing else', () => {
    const { secret, statement } = generateHashLock();
    assert.match(secret, /^0x[0-9a-f]{64}$/);
    assert.equal(opensStatement(secret, statement), true);
    assert.equal(opensStatement(generateHashLock().secret, statement), false);
  });

  test('the statement is sha256 of the secret bytes, not of its hex text', () => {
    // A plausible and wrong implementation hashes the "0x…" string. Two agents
    // doing that differently never settle, so the recipe is pinned here.
    const secret = `0x${'ab'.repeat(32)}`;
    const expected = '0x' + crypto.createHash('sha256')
      .update(Buffer.from('ab'.repeat(32), 'hex')).digest('hex');
    assert.equal(statementFor(secret), expected);
  });

  test('a malformed secret is refused rather than coerced', () => {
    assert.throws(() => statementFor('not-hex'));
    assert.equal(opensStatement('0xshort', `0x${'0'.repeat(64)}`), false);
    assert.equal(opensStatement(null, null), false);
  });
});

describe('tclk derived names', () => {
  test('the deal room is the first 16 hex of the contract id', () => {
    const contract = `0x${'a1b2c3d4e5f60718'}${'0'.repeat(48)}`;
    assert.equal(isContractId(contract), true);
    assert.equal(dealRoom(contract), 'mb-p-tclk-a1b2c3d4e5f60718');
    // It must satisfy the venue's name grammar, or the room cannot exist.
    assert.match(dealRoom(contract), /^[a-z0-9][a-z0-9_-]{0,47}$/);
  });

  test('the state pointer shards off the same id', () => {
    const contract = `0x${'a1b2c3d4e5f60718'}${'0'.repeat(48)}`;
    assert.deepEqual(statePointer(contract), { ns: 'tclk-a1', key: 'b2c3d4e5f60718' });
  });

  test('a bad contract id names no room at all', () => {
    assert.throws(() => dealRoom('0xnope'));
    assert.throws(() => statePointer(undefined));
  });

  test('the rendezvous room and rail token are the documented strings', () => {
    assert.equal(OFFER_ROOM, 'tclk-offers');
    assert.equal(TCLK_DOMAIN, 'FLOP::tclk::v1');
    assert.equal(railToken(['paper']), 'tclk1:paper');
    assert.deepEqual(railsFromNote('mailbox: mb-x | tclk1:paper,x402 | etc'), ['paper', 'x402']);
    assert.deepEqual(railsFromNote('no token here'), []);
  });
});

describe('tclk decoding is fail-closed', () => {
  test('anything that is not a well-formed frame is null', () => {
    for (const bad of [
      null, 42, '', 'hello',
      'tclk1 not json',
      'tclk1 [1,2]',
      'tclk1 {"type":"offer"}',                                    // no from
      'tclk1 {"type":"nonsense","from":"' + PAYER + '"}',          // unknown type
      'tclk1 {"type":"reveal","from":"' + PAYER + '","contract":"0x' + '0'.repeat(64) + '"}', // no secret
      'tclk2 {"type":"offer"}'                                     // another version
    ]) {
      assert.equal(decodeFrame(bad), null, `should refuse: ${String(bad).slice(0, 40)}`);
    }
  });

  test('a self-asserted from that is not a did:key is refused', () => {
    const line = encodeFrame({ type: 'cancel', from: PAYER, contract: `0x${'0'.repeat(64)}` });
    assert.ok(decodeFrame(line));
    assert.equal(decodeFrame(line.replace(PAYER, 'nick')), null);
  });

  test('an oversized frame is refused before it reaches the wire', () => {
    assert.throws(() => encodeFrame({ type: 'cancel', from: PAYER, note: 'x'.repeat(5000) }));
  });
});

describe('tclk deadlines', () => {
  test('the claim window must exist and be ahead of us', () => {
    const now = 1_000;
    assert.equal(validateDeadlines({ claimByMs: 5_000, refundAfterMs: 9_000 }, now).ok, true);
    assert.equal(validateDeadlines({ claimByMs: 5_000, refundAfterMs: 9_000 }, now).claimWindowMs, 4_000);
    assert.equal(validateDeadlines({ claimByMs: 9_000, refundAfterMs: 5_000 }, now).ok, false);
    assert.equal(validateDeadlines({ claimByMs: 9_000, refundAfterMs: 9_000 }, now).ok, false);
    assert.equal(validateDeadlines({ claimByMs: 500, refundAfterMs: 9_000 }, now).ok, false);
    assert.equal(validateDeadlines({ claimByMs: 5_000, refundAfterMs: 9_000, expiresMs: 900 }, now).ok, false);
  });
});

describe('tclk state machine', () => {
  const contract = `0x${'c'.repeat(64)}`;
  const lock = generateHashLock();

  const opened = () => openContract(
    { ...anOffer(), from: PAYER, role: 'payer' },
    { from: PAYEE, contract }
  );

  const accepted = () => applyFrame(opened(),
    { type: 'accept', from: PAYEE, contract, statement: lock.statement, ref: '0x' + '1'.repeat(64) });

  const locked = () => applyFrame(accepted(), { type: 'lock', from: PAYER, contract, rail: 'paper' });

  test('roles come from the offer, not from who spoke last', () => {
    const state = opened();
    assert.equal(state.payer, PAYER);
    assert.equal(state.payee, PAYEE);

    const reversed = openContract({ ...anOffer(), from: PAYER, role: 'payee' }, { from: PAYEE, contract });
    assert.equal(reversed.payer, PAYEE);
    assert.equal(reversed.payee, PAYER);
  });

  test('the happy path walks proposed to claimed', () => {
    assert.equal(opened().status, 'proposed');
    assert.equal(accepted().status, 'accepted');
    assert.equal(locked().status, 'locked');

    const claimed = applyFrame(locked(), { type: 'reveal', from: PAYEE, contract, secret: lock.secret }, 2_500_000);
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.secret, lock.secret);
  });

  test('a wrong secret does not claim anything', () => {
    const other = generateHashLock().secret;
    const tried = applyFrame(locked(), { type: 'reveal', from: PAYEE, contract, secret: other }, 2_500_000);
    assert.equal(tried.status, 'locked');
    assert.match(tried.reason, /does not open/);
  });

  test('a stranger cannot move somebody else\'s contract', () => {
    const tried = applyFrame(locked(), { type: 'reveal', from: STRANGER, contract, secret: lock.secret }, 2_500_000);
    assert.equal(tried.status, 'locked');
    assert.match(tried.reason, /not from a party/);
  });

  test('each side may only make its own move', () => {
    const payerReveal = applyFrame(locked(), { type: 'reveal', from: PAYER, contract, secret: lock.secret }, 2_500_000);
    assert.match(payerReveal.reason, /only the payee/);

    const payeeRefund = applyFrame(locked(), { type: 'refund', from: PAYEE, contract }, 4_000_000);
    assert.match(payeeRefund.reason, /only the payer/);
  });

  test('the refund deadline is a real boundary in both directions', () => {
    const early = applyFrame(locked(), { type: 'refund', from: PAYER, contract }, 2_999_999);
    assert.equal(early.status, 'locked');
    assert.match(early.reason, /before the deadline/);

    const onTime = applyFrame(locked(), { type: 'refund', from: PAYER, contract }, 3_000_000);
    assert.equal(onTime.status, 'refunded');

    const late = applyFrame(locked(), { type: 'reveal', from: PAYEE, contract, secret: lock.secret }, 3_000_000);
    assert.equal(late.status, 'locked', 'a reveal at the refund deadline is too late');
  });

  test('a rail nobody offered is refused', () => {
    const tried = applyFrame(accepted(), { type: 'lock', from: PAYER, contract, rail: 'some-chain' });
    assert.equal(tried.status, 'accepted');
    assert.match(tried.reason, /rail was not offered/);
  });

  test('frames out of order change nothing', () => {
    assert.match(applyFrame(opened(), { type: 'lock', from: PAYER, contract, rail: 'paper' }).reason, /not valid from proposed/);
    assert.match(applyFrame(opened(), { type: 'reveal', from: PAYEE, contract, secret: lock.secret }).reason, /not valid from proposed/);
    assert.match(applyFrame(accepted(), { type: 'accept', from: PAYEE, contract, statement: lock.statement }).reason, /not valid from accepted/);
  });

  test('a terminal contract stays terminal, and a replay is a no-op', () => {
    const claimed = applyFrame(locked(), { type: 'reveal', from: PAYEE, contract, secret: lock.secret }, 2_500_000);
    const replayed = applyFrame(claimed, { type: 'reveal', from: PAYEE, contract, secret: lock.secret }, 2_500_000);
    assert.equal(replayed.status, 'claimed');
    assert.match(replayed.reason, /contract is claimed/);

    const cancelled = applyFrame(opened(), { type: 'cancel', from: PAYER, contract });
    assert.equal(cancelled.status, 'cancelled');
    assert.match(applyFrame(cancelled, { type: 'cancel', from: PAYEE, contract }).reason, /contract is cancelled/);
  });

  test('cancel is only possible before money is claimed to exist', () => {
    assert.equal(applyFrame(accepted(), { type: 'cancel', from: PAYEE, contract }).status, 'cancelled');
    assert.match(applyFrame(locked(), { type: 'cancel', from: PAYER, contract }).reason, /not valid from locked/);
  });

  test('a receipt acknowledges and moves nothing', () => {
    const state = locked();
    const after = applyFrame(state, { type: 'receipt', from: PAYEE, contract, outcome: 'claimed' });
    assert.equal(after.status, 'locked');
  });
});

/**
 * The note is how a counterparty finds us before spending a message. The spec
 * is explicit that it proves nothing — world-writable and forgeable — so the
 * only honest thing to put in it is a rail we can actually settle on.
 */
describe('What we advertise in the DID note', () => {
  test('the token round-trips through the note format', async () => {
    const { TechnocoreClient } = await import('../src/technocore-client.mjs');
    let written = null;
    const client = new TechnocoreClient({ baseUrl: 'https://test.example' });
    client.setKv = async (ns, key, value) => { written = value; return true; };

    await client.publishDidProfile(
      { did: PAYER, rawPublicKeyHex: 'ab' },
      { mailbox: 'mb-p-x', rails: ['paper'] }
    );

    assert.match(written, /\| tclk1:paper$/);
    assert.deepEqual(railsFromNote(written), ['paper']);
  });

  test('no rails means no token, rather than an empty one', async () => {
    const { TechnocoreClient } = await import('../src/technocore-client.mjs');
    let written = null;
    const client = new TechnocoreClient({ baseUrl: 'https://test.example' });
    client.setKv = async (ns, key, value) => { written = value; return true; };

    await client.publishDidProfile({ did: PAYER, rawPublicKeyHex: 'ab' }, { mailbox: 'mb-p-x' });

    assert.equal(/tclk1:/.test(written), false);
    assert.deepEqual(railsFromNote(written), []);
  });
});
