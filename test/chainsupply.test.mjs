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

// QNT: the old rule hardcoded the number. This proves the supply is now READ
// from the contract, by changing the stubbed totalSupply and expecting the
// result to follow. Real values (2026-11-21): 45,467,000 total, 0.117 burned.
const QNT = '0x4a220E6096B25EADb88358cb44068A3248254675';

function fakeErc20({ total = '0x000000000000000000000000000000000000000000259c03024205ba6ae00000',
                     dead = '0x0000000000000000000000000000000000000000000000000019f5b0a3c00000' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    calls.push(req.params[0].data);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    // eth_call selectors: totalSupply 0x18160ddd, balanceOf 0x70a08231, decimals 0x313ce567
    const data = req.params[0].data;
    if (data.startsWith('0x313ce567')) return reply('0x' + '12'.padStart(64, '0')); // 18 decimals
    return data.startsWith('0x18160ddd') ? reply(total) : reply(dead);
  };
  return calls;
}

test('quant: circulating supply is read from the contract, not hardcoded', async () => {
  const calls = fakeErc20();
  const s = await readSupply({ method: 'tokens', parts: [{ chain: 'eth', address: QNT }] });
  assert.ok(calls.some(d => d.startsWith('0x18160ddd')), 'totalSupply was actually queried');
  assert.ok(calls.some(d => d.startsWith('0x70a08231')), 'burn balance was actually queried');
  assert.equal(s.total, 45467000);
  // expected values are the exact wei amounts in the stub, scaled by 1e18
  const expectedTotal = Number(BigInt('0x000000000000000000000000000000000000000000259c03024205ba6ae00000')) / 1e18;
  const expectedDead = Number(BigInt('0x0000000000000000000000000000000000000000000000000019f5b0a3c00000')) / 1e18;
  assert.equal(s.total, expectedTotal);
  assert.ok(Math.abs(s.circulating - (expectedTotal - expectedDead)) < 1e-9);
  assert.equal(s.excluded.length, 1);
  assert.match(s.excluded[0].reason, /Burn/);
});

test('quant: a different on-chain total produces a different result (no constant)', async () => {
  fakeErc20({ total: '0x00000000000000000000000000000000000000000018d0bf423c03d8de000000' }); // 30,000,000
  const s = await readSupply({ method: 'tokens', parts: [{ chain: 'eth', address: QNT }] });
  assert.equal(s.total, 30000000);
});
