import test from 'node:test';
import assert from 'node:assert/strict';

import { ss58Address, flopAddressOfDid, ed25519KeyOfDid } from '../src/flop-address.mjs';
import { generateIdentity } from '../src/identity.mjs';

test('matches the well-known Substrate dev vector (Alice, prefix 42)', () => {
  const alice = Buffer.from('d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d', 'hex');
  assert.equal(ss58Address(alice), '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
});

test('our two agents map to the addresses the devnet faucet funded on 2026-10-23', () => {
  assert.equal(flopAddressOfDid('did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn'),
    '5HPMg2por4z8zStWWH5wNNWojMCfX6zrUSfbd8ezea5Z8Vcx');
  assert.equal(flopAddressOfDid('did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW'),
    '5CTfeRiyivtoWQEMveB8CKqKDXdXW1JwnM5XJoMK3oKNgV6A');
});

test('any freshly generated identity has a 32-byte key and an address', () => {
  const { did } = generateIdentity();
  assert.equal(ed25519KeyOfDid(did).length, 32);
  assert.match(flopAddressOfDid(did), /^5[1-9A-HJ-NP-Za-km-z]{47}$/);
});

test('anything that is not an Ed25519 did:key is refused', () => {
  assert.throws(() => flopAddressOfDid('did:web:example.com'));
  assert.throws(() => flopAddressOfDid('did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'));
});
