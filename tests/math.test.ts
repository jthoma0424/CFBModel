import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakEven, evaluateSpread, fitWeights, gradeSpread, movRatings, normCdf, payout } from '../lib/model/math.ts';
import { parseManualCsv, parseRatingTable, parseSagarin } from '../lib/scrapers/parsers.ts';

const close = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('normal CDF', () => {
  close(normCdf(0), 0.5);
  close(normCdf(1.96), 0.975);
  close(normCdf(-1), 0.1587);
});

test('pricing', () => {
  close(payout(-110), 0.9091);
  close(payout(150), 1.5);
  close(breakEven(-110), 0.5238);
});

test('spread evaluation picks the right side', () => {
  // Model: home by 10. DK: home -7  => +3 edge on home
  const e = evaluateSpread(10, -7, 14);
  assert.equal(e.side, 'home');
  close(e.edge, 3);
  assert.ok(e.coverProb > 0.58 && e.coverProb < 0.59);
  assert.ok(e.ev > 0);
  // Model: home by 3. DK: home -10 => away +10 has 7 pts of edge
  const f = evaluateSpread(3, -10, 14);
  assert.equal(f.side, 'away');
  close(f.edge, 7);
  assert.equal(f.spread, 10);
});

test('ATS grading', () => {
  assert.equal(gradeSpread(10, 'home', -7), 'win');
  assert.equal(gradeSpread(7, 'home', -7), 'push');
  assert.equal(gradeSpread(3, 'away', -7), 'win');
  assert.equal(gradeSpread(14, 'away', -7), 'loss');
});

test('MOV ratings recover true strengths', () => {
  const truth = new Map([[1, 14], [2, 7], [3, 0], [4, -7], [5, -14]]);
  const games = [];
  for (const h of truth.keys()) for (const a of truth.keys()) if (h !== a) games.push({ home: h, away: a, margin: truth.get(h)! - truth.get(a)! + 2.5, neutral: false });
  const r = movRatings(games, new Map([...truth.keys()].map((k) => [k, 0])), { hfa: 2.5, cap: 1000, lambda: 0.001 });
  const m = [...r.values()].reduce((a, b) => a + b, 0) / r.size;
  for (const [id, v] of truth) close(r.get(id)! - m, v, 0.05);
});

test('weight fitting finds the informative source and HFA', () => {
  const X: number[][] = [], home: number[] = [], y: number[] = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < 400; i++) {
    const good = rnd() * 40, noise = rnd() * 40;
    X.push([good, noise]); home.push(1); y.push(good + 3 + rnd() * 4);
  }
  const fit = fitWeights(X, home, y, 0.01);
  close(fit.weights[0], 1, 0.05);
  assert.ok(fit.weights[1] < 0.05);
  close(fit.hfa, 3, 0.3);
});

test('Sagarin parser', () => {
  const txt = `
   1  Alabama              A  =  95.26    5   0   76.44(   9)    0   0  |    2   0  |   91.30    7 |   96.12    4 |   99.58    1 |  103.50    1  SEC                 (A)
  64  South Dakota State   AA =  74.10    4   1   60.11( 120)    0   0  |    0   1  |   75.00   60 |   73.20   66 |   74.00   65 |   73.90   66  MISSOURI VALLEY     (AA)
  65  Miami-Ohio           A  =  73.90    3   2   65.00(  80)    0   0  |    0   1  |   72.80   70 |   73.10   67 |   74.20   64 |   75.00   60  MAC                 (A)`;
  const r = parseSagarin(txt);
  assert.equal(r.length, 3);
  assert.equal(r[0].team, 'Alabama');
  assert.equal(r[0].rating, 91.3);
  assert.equal(r[1].division, 'AA');
  assert.equal(r[2].team, 'Miami-Ohio');
});

test('generic table parser + manual csv', () => {
  const html = `<table><tr><th>Rk</th><th>Team</th><th>FEI</th></tr><tr><td>1</td><td>Georgia (5-0)</td><td>1.42</td></tr><tr><td>2</td><td>Texas</td><td>-0.31</td></tr></table>`;
  assert.deepEqual(parseRatingTable(html, /^FEI$/i), [{ team: 'Georgia', rating: 1.42 }, { team: 'Texas', rating: -0.31 }]);
  assert.deepEqual(parseManualCsv('Team,Rating\n1\tOhio State\t26.1\n"Texas A&M", 12'), [{ team: 'Ohio State', rating: 26.1 }, { team: 'Texas A&M', rating: 12 }]);
});
