'use strict';
// Unit tests of the scoring rules: the pure block of content.js, between its scoring markers.
// Run with `node --test` (Node 18+, no dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const begin = source.indexOf('// ==== scoring:begin ====');
const end = source.indexOf('// ==== scoring:end ====');
assert.ok(begin !== -1 && end > begin, 'scoring markers not found in content.js');
const { parseSize, parseRelease, parseCells, titleKey, scoreGroup, explain } = new Function(
  source.slice(begin, end) + '\nreturn { parseSize, parseRelease, parseCells, titleKey, scoreGroup, explain };')();

// The "Versions" list of L'Odyssee (2026) as seen on a C411 torrent page: the cells of each row.
const H1 = 'L.Odyssee.2026.IMAX.MULTI.VF2.2160p.BluRay.4KLight.DV.HDR10Plus.DTS.HD.MA.5.1.x265-SpK79';
const PAGE_SEEDERS = 975;
const ROWS = [
  'Pure|MULTI.VFF|2160p|BDMV|HDR10|DTS-HD MA 5.1|H.265|HYPERION|PURE-UHD-BDMV|91,3 Go',
  'MULTI.VF2|2160p|Remux|DV.HDR10+|DTS-HD MA 5.1|H.265|IMAX|PURE-UHD-REMUX|84,3 Go',
  'MULTI.VFQ|2160p|Remux|HDR10|DTS-HD MA 5.1|H.265|OZEF|PURE-UHD-REMUX|83 Go',
  'MULTI.VFQ|1080p|BDMV|DTS-HD MA 5.1|H.264|TMT|PURE-BD-BDMV|77,2 Go',
  'MULTI.VFF|1080p|BDMV|DTS-HD MA 5.1|H.264|AD|PURE-BD-BDMV|45,6 Go',
  'MULTI.VF2|1080p|Remux|DTS-HD MA 5.1|H.264|IMAX|ALN|PURE-BD-REMUX|42,8 Go',
  'MULTI.VFQ|1080p|Remux|DTS-HD MA 5.1|H.264|PURE-BD-REMUX|42,7 Go',
  'MULTI.VFQ|1080p|Remux|DTS-HD MA 5.1|H.264|OZEF|PURE-BD-REMUX|41,7 Go',
  'HC Opti|MULTI.VFF|2160p|BluRay|HDR10|DTS-HD MA 5.1|H.265|SESKAPiLE|HCOPT-2160-BD-H265|47,2 Go',
  'MULTI.VF2|2160p|BluRay|DV.HDR10+|EAC3 5.1|H.265|IMAX|GiZ69|HCOPT-2160-BD-H265|27,6 Go',
  'MULTI.VF2|2160p|4KLight|DV.HDR10+|DTS-HD MA 5.1|H.265|IMAX|SpK79|HCOPT-2160-4KL-H265|14,1 Go',
  'MULTI.VF2|2160p|4KLight|DV.HDR10+|EAC3 5.1|AV1|IMAX|AMTV|HCOPT-2160-4KL-AV1|10 Go',
  'MULTI.VFQ|2160p|BluRay|DV.HDR10+|DTS-HD MA 5.1|AV1|IMAX|WHY7726|HCOPT-2160-BD-AV1|9,7 Go',
  'MULTI.VF2|2160p|BluRay|DV.HDR10+|EAC3 5.1|AV1|IMAX|WHY7726|Lossy/Lossless|Correctif|HCOPT-2160-BD-AV1|6,6 Go',
  'MULTI.VF2|2160p|4KLight|DV.HDR10+|EAC3 5.1|H.265|IMAX|HCOPT-2160-4KL-H265|5,8 Go',
  'MULTI.VF2|2160p|4KLight|DV.HDR10+|Opus 5.1|AV1|IMAX|ZAMIAK|HCOPT-2160-4KL-AV1|5,8 Go',
  'MULTI.VF2|1080p|HDLight|EAC3 5.1|H.265|IMAX|BATGirl|HCOPT-1080-WR-H265|5,5 Go',
  'MULTI.VF2|1080p|BluRay|Opus 5.1|AV1|IMAX|HCOPT-1080-BD-AV1|5 Go',
  'VOSTFR|1080p|BluRay|DTS-HD MA 5.1|H.265|BONUS|HCOPT-1080-BD-H265|2,8 Go',
  'MULTI.VFQ|1080p|HDLight|Opus 5.1|AV1|REDWOLF77|HCOPT-1080-WR-AV1|2,7 Go',
  'VOSTFR|1080p|HDLight|AAC 5.1|H.265|Rapta|Lossy/Lossless|HCOPT-1080-BD-H265|2,2 Go',
  'Opti|MULTI.VFQ|2160p|BluRay|DV.HDR10+|EAC3 5.1|H.265|IMAX|GiZ69|OPTI-2160-HDR|16,5 Go',
  'MULTI.VF2|2160p|4KLight|DV.HDR10+|EAC3 5.1|H.265|IMAX|OPTI-2160-HDR-4KL|9,9 Go',
  'MULTI.VF2|2160p|4KLight|DV.HDR10+|EAC3 5.1|H.265|IMAX|NEOSTARK|OPTI-2160-HDR-4KL|6,6 Go',
  'MULTI.VFF|1080p|BluRay|DTS 5.1|H.264|IMAX|HK31|OPTI-1080-HDR|14,8 Go',
  'MULTI.VF2|1080p|BluRay|EAC3 5.1|H.265|IMAX|Ifrit|OPTI-1080-SDR-BD|10,5 Go',
  'VFF|1080p|HDLight|AC3 5.1|H.264|ROMKENT|OPTI-1080-SDR-BD|6,6 Go',
  'MULTI.VFF|1080p|HDLight|EAC3 5.1|H.265|GL0P|OPTI-1080-SDR-WR|3,9 Go',
  'MULTI.VFQ|1080p|HDLight|AC3 5.1|H.265|SUPERFLU|OPTI-1080-SDR-WR|3,6 Go',
  'Compat|VOSTFR|1080p|BluRay|DTS-HD MA 5.1|H.264|BONUS|COMPAT-01|26,1 Go',
  'MULTI.VFQ|1080p|BluRay|DTS-HD MA 5.1|H.264|SUPERFLU|COMPAT-01|17,7 Go',
  'MULTI.VF2|1080p|HDLight|EAC3 5.1|H.264|GL0P|COMPAT-WR|9,7 Go',
  'MULTI.VFQ|1080p|BluRay|AC3 5.1|H.264|COMPAT-01|9 Go',
  'MULTI.VF2|1080p|HDLight|AC3 5.1|H.264|IMAX|BATGirl|COMPAT-WR|5,5 Go'
].map((row) => row.split('|'));

const rowOf = (...cells) => ROWS.findIndex((row) => cells.every((cell) => row.includes(cell)));
const CURRENT = rowOf('MULTI.VF2', '2160p', '4KLight', 'DTS-HD MA 5.1', '14,1 Go');
const LIGHT = rowOf('MULTI.VF2', '2160p', '4KLight', 'EAC3 5.1', 'H.265', '5,8 Go');
const REMUX = rowOf('MULTI.VF2', '2160p', 'Remux', '84,3 Go');
const IMAGE = rowOf('MULTI.VFF', '2160p', 'BDMV', '91,3 Go');
assert.ok([CURRENT, LIGHT, REMUX, IMAGE].every((i) => i >= 0), 'fixture row not found');

// Only the page's own torrent shows its seeders in the list of versions.
const versions = (seeders = PAGE_SEEDERS) =>
  ROWS.map((cells, i) => parseCells(cells.slice(), i === CURRENT ? { seeders } : null));
const awarded = (group, key) => group.rows.flatMap((row, i) => (row.awards.includes(key) ? [i] : []));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !~ ${expected}`);

test('parseSize reads French and dot decimals and every unit', () => {
  near(parseSize('14,1 Go'), 14.1);
  near(parseSize('3.5 Go'), 3.5);
  near(parseSize('10 Go'), 10);
  near(parseSize('348.1 Mo'), 348.1 / 1024);
  near(parseSize('1,5 To'), 1536);
  for (const text of ['29,78 To échangés', '2160p', 'MULTI.VF2', '', null]) assert.equal(parseSize(text), null);
});

test('parseRelease reads the fields of a release name, and ignores what is not a video', () => {
  const release = parseRelease(H1);
  assert.equal(release.lang.label, 'MULTI.VF2');
  assert.equal(release.res.label, '2160p');
  assert.equal(release.src.label, '4KLight');
  assert.equal(release.hdr.label, 'DV.HDR10+');
  assert.equal(release.audio.label, 'DTS-HD');
  assert.equal(release.codec.label, 'H.265');
  assert.equal(parseRelease('Daft.Punk.Random.Access.Memories.FLAC.24bits'), null);
});

test('parseCells skips the size, the separator, the group label and the team', () => {
  const entry = parseCells(ROWS[CURRENT].slice(), { seeders: 7 });
  near(entry.sizeGB, 14.1);
  assert.equal(entry.seeders, 7);
  assert.equal(entry.release.lang.label, 'MULTI.VF2');
  assert.equal(entry.release.src.label, '4KLight');
  assert.equal(entry.release.codec.label, 'H.265');

  const grid = parseCells(['VOSTFR', '1080p', 'WEBRip', 'AAC', 'H.264', 'AMEN', '·', '348.1 Mo'], { seeders: 'x' });
  near(grid.sizeGB, 348.1 / 1024);
  assert.equal(grid.seeders, null);
  assert.equal(parseCells(['Rock', 'Album', '320 kbps', '85 Mo'], null), null);
});

test('titleKey identifies the film or the season, not the release', () => {
  assert.equal(titleKey(H1), 'lodyssee2026');
  assert.equal(titleKey('L.Odyssee.2026.MULTI.VFF.1080p.BluRay.x264-TEAM'), 'lodyssee2026');
  assert.equal(titleKey('Kaamelott.Premier.Volet.2021.VOF.2160p.Bluray.4KLight.DV.HDR.x265.AC3.5.1-Amen.mkv'),
    'kaamelottpremiervolet2021');
  assert.equal(titleKey('Show.Name.2020.S01E02.MULTI.1080p.WEB.H264-GRP'), 'shownames01e02');
  assert.equal(titleKey('Show.Name.S01.MULTI.1080p.WEB.H264-GRP'), 'shownames01');
  assert.equal(titleKey(''), '');
  assert.equal(titleKey('1080p.BluRay'), '');
});

test('on the real versions list the pick is the light MULTI.VF2 2160p, not a 90 GB disc image', () => {
  const group = scoreGroup(versions());
  assert.equal(group.useSize, true);
  assert.deepEqual(awarded(group, 'best'), [LIGHT]);
  assert.deepEqual(awarded(group, 'value'), [LIGHT]);
  assert.deepEqual(awarded(group, 'quality'), [REMUX]);
  assert.deepEqual(awarded(group, 'seeds'), []);
  assert.ok(group.rows[LIGHT].score > group.rows[IMAGE].score);
  assert.ok(group.rows.every((row) => row.score >= 0 && row.score <= 100));
});

test('seeders count only when every torrent has them: the unique leader gets the bolt', () => {
  const unknown = scoreGroup(versions());
  assert.equal(unknown.useHealth, false);
  assert.equal(unknown.rows[CURRENT].parts.health, undefined);

  const seeded = versions().map((entry, i) => Object.assign(entry, { seeders: i === LIGHT ? 500 : 5 }));
  const known = scoreGroup(seeded);
  assert.equal(known.useHealth, true);
  assert.ok(known.rows[LIGHT].parts.health > known.rows[REMUX].parts.health);
  assert.deepEqual(awarded(known, 'seeds'), [LIGHT]);

  const tie = scoreGroup(versions().map((entry) => Object.assign(entry, { seeders: 9 })));
  assert.deepEqual(awarded(tie, 'seeds'), []);
});

test('a torrent without seeders is capped and never recommended', () => {
  const group = scoreGroup([
    parseCells(ROWS[LIGHT].slice(), { seeders: 0 }),
    parseCells(ROWS[REMUX].slice(), { seeders: 3 })
  ]);
  assert.equal(group.rows[0].dead, true);
  assert.ok(group.rows[0].score <= 35);
  assert.deepEqual(group.rows[0].awards, []);
  assert.ok(group.rows[1].awards.includes('best'));
});

test('a lone torrent is scored but gets no award', () => {
  const group = scoreGroup([parseCells(ROWS[LIGHT].slice(), { seeders: 12 })]);
  assert.equal(group.useSize, false);
  assert.deepEqual(group.rows[0].awards, []);
  assert.ok(group.rows[0].score > 0);
});

test('the value award never goes to a release in a worse language', () => {
  const entry = (name, sizeGB) => ({ release: parseRelease(name), sizeGB, seeders: null });
  const group = scoreGroup([
    entry('Film.2020.VOSTFR.1080p.BluRay.x265', 1),
    entry('Film.2020.MULTI.VFF.1080p.BluRay.x265', 4),
    entry('Film.2020.MULTI.VFF.1080p.BluRay.x265', 40)
  ]);
  assert.deepEqual(awarded(group, 'value'), [1]);
  assert.deepEqual(awarded(group, 'best'), [1]);
  assert.ok(group.rows[1].score > group.rows[0].score);
});

test('a release with unknown fields is still scored', () => {
  const entry = (name) => ({ release: parseRelease(name), sizeGB: 3, seeders: null });
  const group = scoreGroup([entry('Film.2020.1080p.WEB.x264'), entry('Film.2020.MULTI.VFF.1080p.WEB.x264')]);
  assert.ok(group.rows[0].score < group.rows[1].score);
  assert.ok(group.rows.every((row) => Number.isInteger(row.score)));
});

test('explain gives the score, the awards and what was left out', () => {
  const entries = versions();
  const group = scoreGroup(entries);
  const best = explain(entries[LIGHT], group.rows[LIGHT], group);
  assert.match(best, /^Score \d+\/100\n/);
  assert.match(best, /Meilleur choix/);
  assert.match(best, /Meilleur rapport qualité\/taille/);
  assert.match(best, /Seeders inconnus/);
  assert.match(explain(entries[CURRENT], group.rows[CURRENT], group), /Seeders : 975 \(non comptés/);

  const dead = scoreGroup([parseCells(ROWS[LIGHT].slice(), { seeders: 0 }), parseCells(ROWS[REMUX].slice(), { seeders: 3 })]);
  assert.match(explain(parseCells(ROWS[LIGHT].slice(), { seeders: 0 }), dead.rows[0], dead), /plafonné à 35/);
});
