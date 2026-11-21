import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readSupply } from '../collector/sources/chainsupply.mjs';

// Real response shapes, captured from BNB Chain's public RPC and bnbburn.info on 2026-11-21. No network in tests.
const BALANCES = {
  '0x0000000000000000000000000000000000001004': '0x157a9cb53fd94060e95045', // TokenHub ~25,966,461.7
  '0x000000000000000000000000000000000000dead': '0xf02fa7f3c8ab4aed33f9e', // burn address ~18,147,952.9
  '0x0000000000000000000000000000000000000000': '0x150430259f7af74df946', // zero address ~99,246.95
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Fake fetch: answers eth_getBalance from BALANCES and the burn tracker with the given body.
function fakeChain(tracker) {
  globalThis.fetch = async (url, opts = {}) => {
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (String(url).includes('bnbburn.info')) return reply(tracker);
    const req = JSON.parse(opts.body);
    assert.equal(req.method, 'eth_getBalance');
    return reply({ jsonrpc: '2.0', id: req.id, result: BALANCES[req.params[0].toLowerCase()] });
  };
}

test('bnb: circulating is the lower of the chain ceiling and BNB Chain burn tracker', async () => {
  fakeChain({ bcSupply: 0, bscSupply: 131510229.21 });
  const s = await readSupply({ method: 'bnb' });
  const ceiling = 176406560.9 - 25966461.675289 - 18147952.881559 - 99246.95247;
  assert.ok(Math.abs(s.total - ceiling) < 0.01);
  assert.ok(Math.abs(s.circulating - 131510229.21) < 0.01);
  assert.ok(s.circulating <= s.total);
  const out = s.excluded.reduce((a, e) => a + e.amount, 0);
  assert.ok(Math.abs(176406560.9 - out - s.circulating) < 0.01, 'excluded wallets explain the whole gap');
  assert.equal(s.checked, true);
});

test('bnb: tracker above the chain ceiling never raises circulating', async () => {
  fakeChain({ bcSupply: 0, bscSupply: 132500000 });
  const s = await readSupply({ method: 'bnb' });
  assert.equal(s.circulating, s.total);
  assert.equal(s.excluded.length, 3);
});

test('bnb: a broken tracker fails the read instead of guessing', async () => {
  fakeChain({ bcSupply: 0, bscSupply: 0 });
  await assert.rejects(readSupply({ method: 'bnb' }), /tracker/);
  fakeChain({ bcSupply: 0, bscSupply: 90000000 });
  await assert.rejects(readSupply({ method: 'bnb' }), /tracker/);
});

// Real response shapes from https://api.avax.network/ext/bc/P, captured 2026-11-21.
// Both values are nAVAX (1e9 = 1 AVAX).
const AVAX_SUPPLY = '476832490963925666'; // platform.getCurrentSupply
const AVAX_STAKE = '218527845251212792';  // platform.getTotalStake

// Fake fetch: answers the two P-chain methods we call, and records them.
function fakeAvax({ supply = AVAX_SUPPLY, stake = AVAX_STAKE, error = null } = {}) {
  const methods = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    methods.push(req.method);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (error) return reply({ jsonrpc: '2.0', id: req.id, error: { message: error } });
    if (req.method === 'platform.getCurrentSupply') return reply({ jsonrpc: '2.0', id: req.id, result: { supply, height: '25920780' } });
    if (req.method === 'platform.getTotalStake') return reply({ jsonrpc: '2.0', id: req.id, result: { stake, weight: stake } });
    throw new Error('unexpected method ' + req.method);
  };
  return methods;
}

test('avax: circulating is P-chain supply minus locked stake', async () => {
  const methods = fakeAvax();
  const s = await readSupply({ method: 'avax' });
  assert.deepEqual(methods.sort(), ['platform.getCurrentSupply', 'platform.getTotalStake']);
  assert.ok(Math.abs(s.total - 476832490.9639257) < 1e-6);
  assert.ok(Math.abs(s.circulating - (476832490.9639257 - 218527845.2512128)) < 1e-6);
  assert.equal(s.excluded.length, 1);
  assert.equal(s.excluded[0].amount, 218527845.2512128);
  assert.match(s.excluded[0].reason, /stake/i);
  assert.equal(s.checked, true);
  assert.equal(s.method, 'avax');
  assert.ok(s.circulating > 0 && s.circulating < s.total, 'stake is actually subtracted');
});

test('avax: stake above supply fails the read instead of publishing a negative', async () => {
  fakeAvax({ supply: '1000000000000000', stake: '2000000000000000' });
  await assert.rejects(readSupply({ method: 'avax' }), /exceeds supply/);
});

test('avax: an RPC error fails the read', async () => {
  fakeAvax({ error: 'method not found' });
  await assert.rejects(readSupply({ method: 'avax' }), /avax platform\./);
});

test('avax: an empty supply read fails rather than reporting zero', async () => {
  fakeAvax({ supply: '0' });
  await assert.rejects(readSupply({ method: 'avax' }), /empty supply/);
});
