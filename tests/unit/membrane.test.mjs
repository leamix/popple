import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMembrane } from '../../public/js/core/membrane.js';

test('edge contact leaves a local dent and a surviving lobe on the freer side', () => {
  for (let i = 0; i < 100; i++) {
    const angle = i * 2.39996, x = Math.cos(angle) * .8, y = Math.sin(angle) * .8;
    const m = makeMembrane(i / 101, x, y);
    assert.ok(m.dent[0] * x + m.dent[1] * y > .30);
    assert.ok(m.pockets[0] * x + m.pockets[1] * y < -.25);
    assert.ok(m.air > .14 && m.pockets[2] > .15, 'vented film retains molded volume');
  }
});

test('changing contact changes the permanent geometry while preserving seeded identity', () => {
  const a = makeMembrane(.37, -.8, .1), b = makeMembrane(.37, .8, .1);
  assert.equal(a.air, b.air);
  assert.deepEqual(a.profiles, b.profiles);
  assert.notDeepEqual(a.dent, b.dent);
  assert.notDeepEqual(a.pockets, b.pockets);
  assert.notDeepEqual(a.folds, b.folds);
  assert.deepEqual(a, makeMembrane(.37, -.8, .1));
});

test('seeded surfaces stay varied and bounded even at diagonal contact limits', () => {
  const signatures = new Set();
  for (let i = 0; i < 100; i++) {
    const m = makeMembrane(i / 101, 1, -1);
    signatures.add([...m.folds, ...m.pockets].join(','));
    for (const values of [m.dent, m.pockets, m.folds, m.profiles]) assert.ok([...values].every(Number.isFinite));
    assert.ok(Math.hypot(...m.dent.slice(0, 2)) < .7);
    for (let j = 0; j < 3; j++) assert.ok(Math.hypot(m.pockets[j * 4], m.pockets[j * 4 + 1]) <= .721);
  }
  assert.equal(signatures.size, 100);
});
