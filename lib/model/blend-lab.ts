import { db, selectAll } from '../supabase';
import { OD_SOURCES, loadRatingInputs, ratingSnapshot } from './compute';
import { corr, fitBlend, mae, mean, recordVsLine, rmse, slopeThroughOrigin } from './math';

/**
 * Blend lab: rebuild every past week's ratings exactly as they stood before kickoff,
 * then test how well each source — and each way of blending them — predicted
 *   (a) final margins (spreads) and
 *   (b) points each team actually scored (totals),
 * next to the DraftKings line on the same games.
 *
 * The fitted blend is scored "held out": each week is predicted by a fit that never saw that week.
 */

type Row = {
  week: number; gameId: number;
  x: (number | null)[]; // one feature per source, in points
  cur: number;          // your current blend (no home edge)
  loc: number;          // 1 home, -1 away, 0 neutral
  base: number;         // 0 for margins, league avg for points
  y: number;            // actual margin, or actual points scored
  line: number | null;  // DraftKings: home margin implied by the spread, or team points implied by spread+total
};

const LAMBDAS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];
const r2 = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export async function runBlendLab(season: number) {
  const inp = await loadRatingInputs(season);
  const s = inp.settings;
  if (!inp.sourceRows.length) return { ok: false, message: 'No stored ratings yet. Run Daily first.' };
  const preds = await selectAll<any>((a, b) =>
    db().from('predictions').select('game_id,book_home_spread,book_total').eq('season', season).order('game_id').range(a, b),
  );
  const lines = new Map(preds.map((p) => [p.game_id, p]));
  // Start where most outside sources have a snapshot. In-house EPA is backfilled from week 2,
  // which would otherwise pull in weeks where every other source is missing.
  const earliest = new Map<string, number>();
  for (const r of inp.sourceRows) earliest.set(r.source, Math.min(earliest.get(r.source) ?? Infinity, r.week));
  const outside = [...earliest.entries()].filter(([k]) => !k.startsWith('tcc_')).map(([, w]) => w).sort((x, y) => x - y);
  const firstWeek = outside.length ? outside[Math.floor((outside.length - 1) / 2)] : Math.min(...earliest.values());
  const weeks = [...new Set(inp.games.filter((g) => g.week >= firstWeek).map((g) => g.week))].sort((a, b) => a - b);

  const keys = inp.sources.map((x) => x.key);
  const odKeys = OD_SOURCES.filter((k) => keys.includes(k));
  const marginRows: Row[] = [];
  const pointRows: (Row & { side: 'home' | 'away'; total: number | null })[] = [];

  for (const week of weeks) {
    const snap = ratingSnapshot(inp, week);
    for (const g of inp.games) {
      if (g.week !== week || !inp.isFbs.get(g.home_id) || !inp.isFbs.get(g.away_id)) continue;
      const rh = snap.rating.get(g.home_id), ra = snap.rating.get(g.away_id);
      const ch = snap.comps.get(g.home_id), ca = snap.comps.get(g.away_id);
      if (rh === undefined || ra === undefined || !ch || !ca) continue;
      const l = lines.get(g.id);
      const spread = l?.book_home_spread === null || l?.book_home_spread === undefined ? null : Number(l.book_home_spread);
      const total = l?.book_total === null || l?.book_total === undefined ? null : Number(l.book_total);
      const loc = g.neutral_site ? 0 : 1;
      marginRows.push({
        week, gameId: g.id, loc, base: 0, cur: rh - ra, y: g.home_points - g.away_points,
        x: keys.map((k) => (ch[k] !== undefined && ca[k] !== undefined ? ch[k] - ca[k] : null)),
        line: spread === null ? null : -spread,
      });
      const oh = snap.odBlend.get(g.home_id), oa = snap.odBlend.get(g.away_id);
      const dh = snap.od.get(g.home_id) ?? {}, da = snap.od.get(g.away_id) ?? {};
      if (!oh || !oa) continue;
      const implied = spread !== null && total !== null ? { home: (total - spread) / 2, away: (total + spread) / 2 } : null;
      pointRows.push({
        week, gameId: g.id, side: 'home', loc, base: snap.mu, cur: oh.o + oa.d, y: g.home_points, total,
        x: odKeys.map((k) => (dh[k] && da[k] ? dh[k].o + da[k].d : null)), line: implied?.home ?? null,
      });
      pointRows.push({
        week, gameId: g.id, side: 'away', loc: -loc, base: snap.mu, cur: oa.o + oh.d, y: g.away_points, total,
        x: odKeys.map((k) => (da[k] && dh[k] ? da[k].o + dh[k].d : null)), line: implied?.away ?? null,
      });
    }
  }

  const weightOf = new Map(inp.sources.map((x) => [x.key, x.weight]));
  const odWeightOf = new Map(inp.sources.map((x) => [x.key, x.total_weight ?? x.weight]));
  const margin = analyze(marginRows, keys, s.hfa, s.edge_threshold, weightOf, 'margin');
  const points = analyze(pointRows, odKeys, s.hfa / 2, 0, odWeightOf, 'points');
  if (!margin.ok) return { ok: false, message: margin.message, games: marginRows.length, weeks };

  // Totals: add both teams' projected points per game
  let totals: any = null;
  if (points.ok) {
    const byGame = new Map<number, { cur: number; fit: number; y: number; line: number | null; n: number }>();
    points.rowsOut!.forEach((r) => {
      const t = byGame.get(r.gameId) ?? { cur: 0, fit: 0, y: 0, line: (r as any).total, n: 0 };
      t.cur += r.curPred; t.fit += r.fitPred; t.y += r.y; t.n++;
      byGame.set(r.gameId, t);
    });
    const gamesT = [...byGame.values()].filter((t) => t.n === 2);
    const withLine = gamesT.filter((t) => t.line !== null);
    const L = withLine.map((t) => t.line!), Y = withLine.map((t) => t.y);
    totals = {
      games: gamesT.length, gamesWithLine: withLine.length,
      current: { rmse: r2(rmse(gamesT.map((t) => t.y - t.cur))), record: recordVsLine(withLine.map((t) => t.cur), L, Y, s.total_edge_threshold) },
      fitted: { rmse: r2(rmse(gamesT.map((t) => t.y - t.fit))), record: recordVsLine(withLine.map((t) => t.fit), L, Y, s.total_edge_threshold) },
      line: { rmse: r2(rmse(withLine.map((t) => t.y - t.line!))) },
      lineSameGames: { current: r2(rmse(withLine.map((t) => t.y - t.cur))), fitted: r2(rmse(withLine.map((t) => t.y - t.fit))) },
      threshold: s.total_edge_threshold,
    };
  }

  // What "Apply" would save
  const sumCur = margin.fitted!.keys.reduce((a, k) => a + (weightOf.get(k) ?? 0), 0) || 1;
  const apply: any = {
    weights: Object.fromEntries(margin.fitted!.keys.map((k, i) => [k, r2(margin.fitted!.norm[i] * sumCur, 3)])),
    hfa: r2(Math.min(5, Math.max(0, margin.fitted!.h))),
    margin_slope: r2(Math.min(1.5, Math.max(0.5, margin.fitted!.slope)), 3),
    sigma: margin.heldOut!.rmse,
  };
  if (points.ok) {
    Object.assign(apply, {
      total_weights: Object.fromEntries(points.fitted!.keys.map((k, i) => [k, r2(points.fitted!.norm[i], 3)])),
      points_slope: r2(Math.min(1.5, Math.max(0.5, points.fitted!.slope)), 3),
      total_sigma: totals?.fitted.rmse ?? null,
    });
  }
  delete (margin as any).rowsOut; delete (points as any).rowsOut;
  return { ok: true, season, weeks: [...new Set(marginRows.map((r) => r.week))], margin, points, totals, apply, ranAt: new Date().toISOString() };
}

function analyze(rows: Row[], keys: string[], hfaCur: number, threshold: number, curWeights: Map<string, number>, kind: 'margin' | 'points') {
  const minRows = kind === 'margin' ? 60 : 120;
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);
  if (rows.length < minRows || weeks.length < 3) {
    const games = kind === 'margin' ? rows.length : rows.length / 2;
    return { ok: false as const, message: `Need at least 60 FBS-vs-FBS games over 3+ weeks with ratings stored before kickoff (have ${games} games over ${weeks.length} weeks).` };
  }
  // Use sources present for at least half the games; a missing value falls back to the team's blended number.
  const use = keys.map((_, j) => rows.filter((r) => r.x[j] !== null).length >= rows.length / 2);
  const fk = keys.filter((_, j) => use[j]);
  const X = rows.map((r) => keys.map((_, j) => r.x[j] ?? r.cur).filter((_, j) => use[j]));
  const target = rows.map((r) => r.y - r.base);
  const loc = rows.map((r) => r.loc);
  const k = fk.length;
  const prior = new Array(k).fill(1 / k); // equal weights, slope 1
  const colVar = mean(fk.map((_, j) => mean(X.map((x) => x[j] ** 2)))) || 1;

  // Held-out (leave-one-week-out) predictions for each penalty strength; keep the best.
  const heldOutFor = (mult: number) => {
    const out = new Array(rows.length).fill(0);
    for (const w of weeks) {
      const tr = rows.map((r, i) => (r.week !== w ? i : -1)).filter((i) => i >= 0);
      const f = fitBlend(tr.map((i) => X[i]), tr.map((i) => loc[i]), tr.map((i) => target[i]), prior, mult * tr.length * colVar);
      rows.forEach((r, i) => { if (r.week === w) out[i] = r.base + f.h * r.loc + X[i].reduce((a, v, j) => a + v * f.w[j], 0); });
    }
    return out;
  };
  let best = { mult: LAMBDAS[0], pred: [] as number[], err: Infinity };
  for (const mult of LAMBDAS) {
    const pred = heldOutFor(mult);
    const err = rmse(pred.map((p, i) => rows[i].y - p));
    if (err < best.err) best = { mult, pred, err };
  }
  const full = fitBlend(X, loc, target, prior, best.mult * rows.length * colVar);
  const slope = full.w.reduce((a, b) => a + b, 0);
  const norm = full.w.map((v) => (slope > 0 ? v / slope : 1 / k));

  const curPred = rows.map((r) => r.base + r.cur + hfaCur * r.loc);
  const eqPred = rows.map((r, i) => r.base + mean(X[i]) + hfaCur * r.loc);
  const fitPred = best.pred;

  // Compare on games that had a DraftKings line when there are enough of them.
  const lineIdx = rows.map((r, i) => (r.line !== null ? i : -1)).filter((i) => i >= 0);
  const evalIdx = lineIdx.length >= (kind === 'margin' ? 40 : 80) ? lineIdx : rows.map((_, i) => i);
  const onLine = evalIdx === lineIdx;
  const stat = (pred: number[], idx = evalIdx) => {
    const err = idx.map((i) => rows[i].y - pred[i]);
    const li = idx.filter((i) => rows[i].line !== null);
    const res: any = { n: idx.length, rmse: r2(rmse(err)), mae: r2(mae(err)) };
    if (kind === 'margin' && li.length) {
      res.record = recordVsLine(li.map((i) => pred[i]), li.map((i) => rows[i].line!), li.map((i) => rows[i].y), threshold);
      // Does the prediction add anything beyond the line? 0 = no, 1 = trust it fully.
      res.beyondLine = r2(slopeThroughOrigin(li.map((i) => pred[i] - rows[i].line!), li.map((i) => rows[i].y - rows[i].line!)));
    }
    return res;
  };
  const candidates: any[] = [
    { name: 'Your current blend', ...stat(curPred) },
    { name: 'Equal weights', ...stat(eqPred) },
    { name: 'Fitted blend (held out)', ...stat(fitPred) },
  ];
  if (lineIdx.length) {
    const lp = rows.map((r) => r.line ?? 0);
    candidates.push({ name: 'DraftKings line', ...stat(lp, lineIdx), isLine: true });
  }

  const perSource = keys.map((key, j) => {
    const idx = rows.map((r, i) => (r.x[j] !== null ? i : -1)).filter((i) => i >= 0);
    const x = idx.map((i) => rows[i].x[j]!);
    const yAdj = idx.map((i) => rows[i].y - rows[i].base - hfaCur * rows[i].loc);
    const fi = fk.indexOf(key);
    const li = idx.filter((i) => rows[i].line !== null);
    return {
      key, n: idx.length,
      slope: r2(slopeThroughOrigin(x, yAdj)),
      corr: r2(corr(x, yAdj)),
      rmse: r2(rmse(idx.map((i, n) => yAdj[n] - x[n]))),
      record: kind === 'margin' && li.length ? recordVsLine(li.map((i) => rows[i].x[j]! + hfaCur * rows[i].loc), li.map((i) => rows[i].line!), li.map((i) => rows[i].y), threshold) : null,
      currentWeight: curWeights.get(key) ?? 0,
      fittedShare: fi >= 0 ? r2(norm[fi], 3) : null,
    };
  });

  return {
    ok: true as const,
    rowsCount: rows.length, onLineGames: onLine, threshold,
    candidates, perSource,
    heldOut: { rmse: r2(best.err), lambda: best.mult },
    fitted: { keys: fk, norm, slope: r2(slope, 3)!, h: full.h },
    rowsOut: rows.map((r, i) => ({ gameId: r.gameId, y: r.y, curPred: curPred[i], fitPred: fitPred[i], total: (r as any).total ?? null })),
  };
}
