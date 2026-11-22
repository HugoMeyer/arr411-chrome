'use strict';
// The « ★ Envoyer le meilleur » button of the torrent page: the pure block of content.js between its best markers,
// fed with groups scored by its scoring block.
// Run with `node --test` (Node 18+, no dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function between(name) {
  const begin = source.indexOf(`// ==== ${name}:begin ====`);
  const end = source.indexOf(`// ==== ${name}:end ====`);
  assert.ok(begin !== -1 && end > begin, `${name} markers not found in content.js`);
  return source.slice(begin, end);
}

const { parseCells, scoreGroup, describe } = new Function(
  between('scoring') + '\nreturn { parseCells, scoreGroup, describe };')();
// Evaluated alone: the best block must not lean on anything outside of it.
const { BEST_TTL_MS, bestIndex, bestTip, bestName, intentFor } = new Function(
  between('best') + '\nreturn { BEST_TTL_MS, bestIndex, bestTip, bestName, intentFor };')();

const version = (cells, seeders) => parseCells(cells.split('|'), { seeders });
const LIGHT = version('MULTI.VF2|2160p|4KLight|DV.HDR10+|EAC3 5.1|H.265|IMAX|5,8 Go', 120);
const IMAGE = version('MULTI.VFF|2160p|BDMV|HDR10|DTS-HD MA 5.1|H.265|91,3 Go', 40);
const POOR = version('VOSTFR|720p|WEBRip|AAC 5.1|H.264|1,2 Go', 5);

test('the best version is the one that earned the ★, never a dead one', () => {
  const group = scoreGroup([LIGHT, IMAGE, POOR]);
  const before = JSON.stringify(group);
  assert.equal(bestIndex(group), 0);
  assert.equal(JSON.stringify(group), before, 'reading the best must not touch the scoring');

  const deadFirst = scoreGroup([version('MULTI.VF2|2160p|4KLight|5,8 Go', 0), POOR]);
  assert.equal(deadFirst.rows[0].dead, true);
  assert.equal(bestIndex(deadFirst), 1);
});

test('no best for a single version, for dead versions only, or without a group', () => {
  assert.equal(bestIndex(scoreGroup([LIGHT])), -1);
  assert.equal(bestIndex(scoreGroup([version('MULTI.VF2|2160p|4KLight|5,8 Go', 0), version('VOSTFR|720p|WEBRip|1,2 Go', 0)])), -1);
  for (const group of [null, undefined, {}, { rows: [] }]) assert.equal(bestIndex(group), -1);
});

test('the tooltip says what a click sends: this page, or another version with its size', () => {
  const group = scoreGroup([LIGHT, IMAGE, POOR]);
  const score = group.rows[0].score;
  const what = describe(LIGHT.release);
  assert.equal(what, 'MULTI.VF2 · 2160p · 4KLight · DV.HDR10+ · EAC3 · H.265');

  assert.equal(bestTip({ current: true, score, what, size: '5,8 Go', profile: '' }),
    `C’est cette version : la mieux notée (score ${score}).`);
  assert.equal(bestTip({ current: false, score, what, size: '5,8 Go', profile: '' }),
    `Meilleure version : MULTI.VF2 · 2160p · 4KLight · DV.HDR10+ · EAC3 · H.265 · 5,8 Go — score ${score}`);
});

test('the tooltip names the profile when it is not the default one, and the accessible name keeps it on one line', () => {
  const info = { current: false, score: 94, what: 'MULTI.VF2 · 2160p', size: '5,8 Go', profile: 'Qualité d’image' };
  const tip = bestTip(info);
  assert.equal(tip, 'Meilleure version : MULTI.VF2 · 2160p · 5,8 Go — score 94\nProfil : Qualité d’image');
  assert.equal(bestTip({ ...info, current: true }), 'C’est cette version : la mieux notée (score 94).\nProfil : Qualité d’image');
  assert.equal(bestName(tip), 'Envoyer le meilleur — Meilleure version : MULTI.VF2 · 2160p · 5,8 Go — score 94 — Profil : Qualité d’image');
  assert.ok(!bestName(tip).includes('\n'));
});

test('a click is honoured on the page of the best version for 20 s, then forgotten', () => {
  const hash = 'a'.repeat(40);
  const from = 'c'.repeat(40);
  const at = 1_000_000;
  assert.equal(BEST_TTL_MS, 20000);
  assert.equal(intentFor({ hash, from, at }, hash, at), 'now');
  assert.equal(intentFor({ hash, from, at }, hash, at + BEST_TTL_MS - 1), 'now');
  assert.equal(intentFor({ hash, from, at }, hash, at + BEST_TTL_MS), 'drop');
  assert.equal(intentFor({ hash, from, at }, hash, at - 1), 'drop');
});

test('a click waits on the page it came from, and is forgotten on any other page', () => {
  const hash = 'a'.repeat(40);
  const from = 'c'.repeat(40);
  const other = 'b'.repeat(40);
  const at = 1_000_000;
  // The click's own toast makes a scan run before the router has moved: still the page of the click.
  assert.equal(intentFor({ hash, from, at }, from, at + 5), 'wait');
  assert.equal(intentFor({ hash, from, at }, other, at + 5), 'drop');
  assert.equal(intentFor({ hash, from, at }, '', at + 5), 'drop');
  assert.equal(intentFor({ hash, from, at }, from, at + BEST_TTL_MS), 'drop');
  // Without an origin there is no page to wait on.
  assert.equal(intentFor({ hash, at }, other, at + 5), 'drop');
  assert.equal(intentFor({ hash, from: '', at }, '', at + 5), 'drop');
});

test('an intent that is missing or not a hash is never honoured', () => {
  const now = 1_000_000;
  for (const intent of [null, undefined, {}, { hash: '', at: now }, { hash: 'abc', at: now }, { hash: 'A'.repeat(40), at: now },
    { hash: 'a'.repeat(40) }, { hash: 'a'.repeat(40), at: 'now' }, { hash: 42, at: now }]) {
    assert.equal(intentFor(intent, 'a'.repeat(40), now), 'drop');
    assert.equal(intentFor(intent, '', now), 'drop');
  }
});
