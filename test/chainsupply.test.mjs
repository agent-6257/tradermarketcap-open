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

// Real response shapes from https://api.avax.network/ext/bc/P and the C-chain RPC, captured 2026-11-21.
// Supply and stake are nAVAX (1e9 = 1 AVAX); the burn balance is wei (1e18 = 1 AVAX).
const AVAX_SUPPLY = '476832857374398361'; // platform.getCurrentSupply
const AVAX_STAKE = '218308361415365485';  // platform.getTotalStake
const AVAX_BURN_HEX = '0x444cc1e63569702c7977e'; // eth_getBalance(burn) = 5,160,589.524773 AVAX
const AVAX_BURN = '0x0100000000000000000000000000000000000000';

// Fake fetch: answers the P-chain methods and the C-chain burn balance, and records them.
function fakeAvax({ supply = AVAX_SUPPLY, stake = AVAX_STAKE, burn = AVAX_BURN_HEX, error = null } = {}) {
  const methods = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    methods.push(req.method);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (error) return reply({ jsonrpc: '2.0', id: req.id, error: { message: error } });
    if (req.method === 'platform.getCurrentSupply') return reply({ jsonrpc: '2.0', id: req.id, result: { supply, height: '25921494' } });
    // stake: null means the node answered without a stake field
    if (req.method === 'platform.getTotalStake') return reply({ jsonrpc: '2.0', id: req.id, result: stake === null ? {} : { stake, weight: stake } });
    if (req.method === 'eth_getBalance') {
      assert.equal(req.params[0], AVAX_BURN);
      return reply({ jsonrpc: '2.0', id: req.id, result: burn });
    }
    throw new Error('unexpected method ' + req.method);
  };
  return methods;
}

const AVAX_TOTAL = 476832857.37439836;
const AVAX_STAKED = 218308361.41536549;
const AVAX_BURNED = 5160589.524773;

test('avax: circulating is P-chain supply minus locked stake and burned AVAX', async () => {
  const methods = fakeAvax();
  const s = await readSupply({ method: 'avax' });
  assert.deepEqual(methods.sort(), ['eth_getBalance', 'platform.getCurrentSupply', 'platform.getTotalStake']);
  assert.ok(Math.abs(s.total - (AVAX_TOTAL - AVAX_BURNED)) < 1e-4, 'total is supply minus burn');
  assert.ok(Math.abs(s.circulating - (AVAX_TOTAL - AVAX_BURNED - AVAX_STAKED)) < 1e-4);
  assert.equal(s.excluded.length, 2);
  const burn = s.excluded.find(e => /burn/i.test(e.reason));
  assert.ok(burn, 'burned AVAX is listed as excluded');
  assert.ok(Math.abs(burn.amount - AVAX_BURNED) < 1e-4);
  assert.equal(burn.src, 'https://snowtrace.io/address/' + AVAX_BURN);
  const stake = s.excluded.find(e => /stake/i.test(e.reason));
  assert.ok(stake, 'locked stake is listed as excluded');
  assert.ok(Math.abs(stake.amount - AVAX_STAKED) < 1e-4);
  assert.equal(s.checked, true);
  assert.equal(s.method, 'avax');
  assert.ok(s.circulating > 0 && s.circulating < s.total, 'stake is actually subtracted');
});

test('avax: burned AVAX lowers both total and circulating', async () => {
  fakeAvax();
  const withBurn = await readSupply({ method: 'avax' });
  fakeAvax({ burn: '0x0' });
  const noBurn = await readSupply({ method: 'avax' });
  assert.ok(Math.abs(noBurn.total - AVAX_TOTAL) < 1e-4);
  assert.ok(Math.abs((noBurn.circulating - withBurn.circulating) - AVAX_BURNED) < 1e-4);
  assert.equal(noBurn.excluded.length, 1);
});

test('avax: stake above supply fails the read instead of publishing a negative', async () => {
  fakeAvax({ supply: '1000000000000000', stake: '2000000000000000' });
  await assert.rejects(readSupply({ method: 'avax' }), /exceeds supply/);
});

test('avax: a missing stake fails instead of publishing NaN', async () => {
  fakeAvax({ stake: null });
  await assert.rejects(readSupply({ method: 'avax' }), /missing stake/);
});

test('avax: an RPC error fails the read', async () => {
  fakeAvax({ error: 'method not found' });
  await assert.rejects(readSupply({ method: 'avax' }), /avax platform\./);
});

test('avax: an empty supply read fails rather than reporting zero', async () => {
  fakeAvax({ supply: '0' });
  await assert.rejects(readSupply({ method: 'avax' }), /empty supply/);
});

test('avax: an unreadable burn balance fails the read', async () => {
  fakeAvax({ burn: null });
  await assert.rejects(readSupply({ method: 'avax' }), /bad burn balance/);
});
