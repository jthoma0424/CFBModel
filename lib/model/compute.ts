import { db, selectAll, upsertChunked } from '../supabase';
import { betProfit, evaluateSpread, fitWeights, gradeSpread, mean, movRatings } from './math';

export type Settings = { hfa: number; sigma: number; edge_threshold: number; margin_cap: number; prior_weight: number; default_price: number };
export type Source = { key: string; name: string; origin: string; scale: number; weight: number; enabled: boolean };

const NON_FBS_DEFAULT = -20; // average FCS team vs. average FBS team, points

export async function getSettings(): Promise<Settings> {
  const { data } = await db().from('model_settings').select('*').eq('id', 1).single();
  const s = data ?? {};
  return {
    hfa: Number(s.hfa ?? 2.5), sigma: Number(s.sigma ?? 14), edge_threshold: Number(s.edge_threshold ?? 3),
    margin_cap: Number(s.margin_cap ?? 28), prior_weight: Number(s.prior_weight ?? 3), default_price: Number(s.default_price ?? -110),
  };
}

export async function getSources(): Promise<Source[]> {
  const { data } = await db().from('rating_sources').select('*').order('key');
  return (data ?? []).map((s) => ({ ...s, scale: Number(s.scale), weight: Number(s.weight) }));
}

/** Weighted mean over whichever sources a team has. */
function blend(components: Record<string, number>, weights: Map<string, number>): number | null {
  let num = 0, den = 0;
  for (const [k, v] of Object.entries(components)) {
    const w = weights.get(k) ?? 0;
    if (w > 0) { num += w * v; den += w; }
  }
  return den > 0 ? num / den : null;
}

/**
 * Build power ratings for model week `week`, using only source snapshots taken
 * at or before that week and game results from earlier weeks.
 */
export async function computePowerRatings(season: number, week: number) {
  const settings = await getSettings();
  const sources = (await getSources()).filter((s) => s.enabled);
  const teams = await selectAll<{ id: number; classification: string | null }>((a, b) => db().from('teams').select('id,classification').range(a, b));
  const isFbs = new Map(teams.map((t) => [t.id, t.classification === 'fbs']));

  // 1) Latest snapshot of each external source as of `week`
  const raw = await selectAll<any>((a, b) =>
    db().from('source_ratings').select('source,team_id,week,rating').eq('season', season).lte('week', week).neq('source', 'tcc_mov')
      .order('week', { ascending: false }).range(a, b),
  );
  const latest = new Map<string, Map<number, number>>(); // source -> team -> raw
  const latestWeek = new Map<string, number>();
  for (const r of raw) {
    if (!latestWeek.has(r.source)) latestWeek.set(r.source, r.week);
    if (r.week !== latestWeek.get(r.source)) continue; // only the newest snapshot of each source
    if (!latest.has(r.source)) latest.set(r.source, new Map());
    latest.get(r.source)!.set(r.team_id, Number(r.rating));
  }

  // 2) Convert each source to points vs. the average FBS team
  const comps = new Map<number, Record<string, number>>();
  for (const s of sources) {
    const m = latest.get(s.key);
    if (!m || !m.size) continue;
    const fbsMean = mean([...m.entries()].filter(([id]) => isFbs.get(id)).map(([, v]) => v));
    for (const [id, v] of m) {
      if (!comps.has(id)) comps.set(id, {});
      comps.get(id)![s.key] = (v - fbsMean) * s.scale;
    }
  }
  const weights = new Map(sources.map((s) => [s.key, s.weight]));

  // 3) In-house MOV rating, regularized toward the external composite
  const priors = new Map<number, number>();
  for (const t of teams) {
    const ext = comps.has(t.id) ? blend(comps.get(t.id)!, new Map([...weights].filter(([k]) => k !== 'tcc_mov'))) : null;
    if (ext !== null) priors.set(t.id, ext);
    else if (isFbs.get(t.id)) priors.set(t.id, 0);
  }
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('home_id,away_id,home_points,away_points,neutral_site').eq('season', season).eq('completed', true).lt('week', week).range(a, b),
  );
  const results = games
    .filter((g) => g.home_points !== null && g.away_points !== null)
    .map((g) => {
      for (const id of [g.home_id, g.away_id]) if (!priors.has(id)) priors.set(id, isFbs.get(id) ? 0 : NON_FBS_DEFAULT);
      return { home: g.home_id, away: g.away_id, margin: g.home_points - g.away_points, neutral: g.neutral_site };
    });
  const useMov = sources.some((s) => s.key === 'tcc_mov');
  if (useMov && (results.length || priors.size)) {
    const mov = movRatings(results, priors, { hfa: settings.hfa, cap: settings.margin_cap, lambda: settings.prior_weight });
    const fbsMean = mean([...mov.entries()].filter(([id]) => isFbs.get(id)).map(([, v]) => v));
    const now = new Date().toISOString();
    const movRows: any[] = [];
    for (const [id, v] of mov) {
      const c = v - fbsMean;
      if (!comps.has(id)) comps.set(id, {});
      comps.get(id)!.tcc_mov = c;
      movRows.push({ season, week, source: 'tcc_mov', team_id: id, rating: Math.round(c * 100) / 100, fetched_at: now });
    }
    await upsertChunked('source_ratings', movRows, 'season,week,source,team_id');
  }

  // 4) Final composite + rank (rank among FBS only)
  const rows: any[] = [];
  for (const [id, c] of comps) {
    const r = blend(c, weights);
    if (r === null) continue;
    rows.push({ season, week, team_id: id, rating: Math.round(r * 100) / 100, components: roundObj(c), computed_at: new Date().toISOString() });
  }
  rows.filter((r) => isFbs.get(r.team_id)).sort((a, b) => b.rating - a.rating).forEach((r, i) => (r.rank = i + 1));
  await upsertChunked('power_ratings', rows, 'season,week,team_id');
  return { teamsRated: rows.length, sources: [...latest.keys()], movGames: results.length };
}

function roundObj(o: Record<string, number>) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}

/** Pick the line to model against: live DraftKings first, then CFBD's DraftKings, then consensus. */
export function bookPriority(): string[] {
  const book = process.env.ODDS_BOOKMAKER || 'draftkings';
  return [book, `cfbd_${book}`, 'cfbd_consensus'];
}

export async function buildPredictions(season: number, week: number) {
  const s = await getSettings();
  const ratings = new Map(
    (await selectAll<any>((a, b) => db().from('power_ratings').select('team_id,rating').eq('season', season).eq('week', week).range(a, b)))
      .map((r) => [r.team_id, Number(r.rating)]),
  );
  const games = await selectAll<any>((a, b) => db().from('games').select('*').eq('season', season).eq('week', week).range(a, b));
  if (!games.length) return { games: 0 };
  const ids = games.map((g) => g.id);
  const lines = await selectAll<any>((a, b) => db().from('latest_lines').select('*').in('game_id', ids).range(a, b));
  const existing = new Map(
    (await selectAll<any>((a, b) => db().from('predictions').select('game_id,frozen').in('game_id', ids).range(a, b))).map((p) => [p.game_id, p]),
  );
  const priority = bookPriority();
  const now = Date.now();
  const rows: any[] = [];
  const freeze: number[] = [];
  for (const g of games) {
    if (existing.get(g.id)?.frozen) continue;
    // Lock predictions at kickoff so the record reflects what you could actually bet.
    if (g.start_date && new Date(g.start_date).getTime() <= now) {
      if (existing.has(g.id)) freeze.push(g.id);
      continue;
    }
    const hr = ratings.get(g.home_id) ?? null;
    const ar = ratings.get(g.away_id) ?? null;
    if (hr === null || ar === null) continue;
    const margin = hr - ar + (g.neutral_site ? 0 : s.hfa);
    const line = priority.map((b) => lines.find((l) => l.game_id === g.id && l.book === b)).find(Boolean);
    const row: any = {
      game_id: g.id, season, week, home_rating: hr, away_rating: ar,
      model_margin: round(margin), model_spread: round(-margin),
      book: null, book_home_spread: null, book_home_price: null, book_away_price: null,
      edge: null, pick_team_id: null, pick_spread: null, cover_prob: null, ev: null, is_play: false,
      updated_at: new Date().toISOString(),
    };
    if (line && line.home_spread !== null) {
      const hp = line.home_price ?? s.default_price, ap = line.away_price ?? s.default_price;
      const e = evaluateSpread(margin, Number(line.home_spread), s.sigma, hp, ap);
      Object.assign(row, {
        book: line.book, book_home_spread: Number(line.home_spread), book_home_price: hp, book_away_price: ap,
        edge: round(e.edge), pick_team_id: e.side === 'home' ? g.home_id : g.away_id, pick_spread: e.spread,
        cover_prob: round(e.coverProb, 4), ev: round(e.ev, 4), is_play: e.edge >= s.edge_threshold,
      });
    }
    rows.push(row);
  }
  await upsertChunked('predictions', rows, 'game_id');
  if (freeze.length) await db().from('predictions').update({ frozen: true }).in('game_id', freeze);
  return { predictions: rows.length, frozen: freeze.length };
}

/** Grade finished predictions and bets. */
export async function gradeAll(season: number) {
  const preds = await selectAll<any>((a, b) =>
    db().from('predictions').select('game_id,pick_team_id,book_home_spread,games!inner(home_id,home_points,away_points,completed)')
      .eq('season', season).is('actual_margin', null).eq('games.completed', true).range(a, b),
  );
  let graded = 0;
  for (const p of preds) {
    const g = p.games;
    if (g.home_points === null) continue;
    const margin = g.home_points - g.away_points;
    const upd: any = { actual_margin: margin, frozen: true };
    if (p.pick_team_id && p.book_home_spread !== null) {
      upd.ats_result = gradeSpread(margin, p.pick_team_id === g.home_id ? 'home' : 'away', Number(p.book_home_spread));
    }
    await db().from('predictions').update(upd).eq('game_id', p.game_id);
    graded++;
  }

  const bets = await selectAll<any>((a, b) =>
    db().from('bets').select('id,team_id,spread,price,stake,games!inner(home_id,home_points,away_points,completed)')
      .is('result', null).eq('games.completed', true).range(a, b),
  );
  for (const b of bets) {
    const g = b.games;
    const teamMargin = (g.home_points - g.away_points) * (b.team_id === g.home_id ? 1 : -1);
    const v = teamMargin + Number(b.spread);
    const result = v > 0 ? 'win' : v < 0 ? 'loss' : 'push';
    await db().from('bets').update({ result, profit: round(betProfit(result, Number(b.stake), b.price), 2) }).eq('id', b.id);
  }
  return { predictionsGraded: graded, betsGraded: bets.length };
}

/**
 * Fit blend weights + HFA from completed games, using the rating components
 * that were stored *before* each game (no look-ahead).
 */
export async function calibrate(season: number) {
  const sources = (await getSources()).filter((s) => s.enabled);
  const keys = sources.map((s) => s.key);
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('id,season,week,home_id,away_id,home_points,away_points,neutral_site').in('season', [season, season - 1]).eq('completed', true).range(a, b),
  );
  const pr = await selectAll<any>((a, b) =>
    db().from('power_ratings').select('season,week,team_id,rating,components').in('season', [season, season - 1]).range(a, b),
  );
  const byKey = new Map(pr.map((r) => [`${r.season}|${r.week}|${r.team_id}`, r]));
  const X: number[][] = [], home: number[] = [], y: number[] = [];
  for (const g of games) {
    const h = byKey.get(`${g.season}|${g.week}|${g.home_id}`), a = byKey.get(`${g.season}|${g.week}|${g.away_id}`);
    if (!h || !a || g.home_points === null) continue;
    // A source missing for a team falls back to that team's composite rating.
    X.push(keys.map((k) => Number(h.components?.[k] ?? h.rating) - Number(a.components?.[k] ?? a.rating)));
    home.push(g.neutral_site ? 0 : 1);
    y.push(g.home_points - g.away_points);
  }
  if (y.length < 50) return { ok: false, games: y.length, message: 'Need at least 50 completed games with stored pregame ratings. Let the model run a few weeks first.' };
  const fit = fitWeights(X, home, y, 5);
  const total = fit.weights.reduce((a, b) => a + b, 0) || 1;
  return {
    ok: true,
    games: y.length,
    hfa: round(fit.hfa),
    sigma: round(fit.rmse),
    shrink: round(total, 3), // <1 means the blended ratings are too spread out
    weights: Object.fromEntries(keys.map((k, i) => [k, round(fit.weights[i] / total, 3)])),
  };
}

function round(v: number, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
