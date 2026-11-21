import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readSupply } from '../collector/sources/chainsupply.mjs';
import { readFileSync } from 'node:fs';

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

// AERO migrated: the live token is 0x3f5bF3Ed..., the old 0x940181a9... is retired
// (static supply). Base uses the same eth_call ABI, so the tokens method covers it.
const AERO_LIVE = '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee';
const AERO_OLD = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';

function fakeBaseErc20(totalWeiHex, tokensQueried) {
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    tokensQueried.push(req.params[0].to);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    const data = req.params[0].data;
    if (data.startsWith('0x313ce567')) return reply('0x' + '12'.padStart(64, '0'));
    if (data.startsWith('0x18160ddd')) return reply(totalWeiHex);
    return reply('0x' + '0'.repeat(64));
  };
}

test('aero: reads the live Aero-migration contract on Base', async () => {
  const queried = [];
  fakeBaseErc20('0x606b11c9592ef29e9000000', queried); // 1,865,000,000
  const s = await readSupply({ method: 'tokens', parts: [{ chain: 'base', address: AERO_LIVE }] });
  assert.ok(queried.every(a => a.toLowerCase() === AERO_LIVE.toLowerCase()), 'only the live contract is queried');
  assert.ok(!queried.some(a => a.toLowerCase() === AERO_OLD.toLowerCase()), 'the retired contract is never queried');
  assert.equal(s.total, 1865000000);
  assert.equal(s.circulating, 1865000000);
});

test('aero: the retired Aerodrome-era contract is not used', async () => {
  const seed = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  const parts = seed.aerodrome.supply.parts;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].chain, 'base');
  assert.equal(parts[0].address.toLowerCase(), AERO_LIVE.toLowerCase());
  assert.notEqual(parts[0].address.toLowerCase(), AERO_OLD.toLowerCase());
});
