import { db, selectAll, upsertChunked } from './supabase';
import { cfbd, maxRegularWeek } from './cfbd';
import { adjustPerPlay, aggregatePlays, mean, type PbpPlay } from './model/math';

/**
 * In-house play-by-play ratings, built the way cfbscrapR/cfbfastR do it, natively:
 *   1. pull CFBD play-by-play (EPA per play = CFBD's "ppa"), one API call per week
 *   2. keep real scrimmage snaps, drop garbage time
 *   3. sum each team's offense per game (EPA, success rate, explosiveness, rush/pass)
 *   4. opponent-adjust with a ridge regression, rebuilt for every week using only earlier games
 * Saved as rating source `tcc_epa` (net adj. EPA/play, plus offense/defense for totals).
 */
const MAX_WEEKS_PER_RUN = 4; // keeps one run well inside Vercel's time limit; the next run continues
const LAMBDA_PLAYS = 150;    // shrinkage: about 2 games of plays pulled toward average
const FCS = -1;              // all non-FBS opponents pooled into one team

export async function syncPlayByPlay(season: number) {
  const [games, fetched, maxReg] = await Promise.all([
    selectAll<any>((a, b) => db().from('games').select('id,week,season_type,start_date,home_id,away_id,neutral_site,completed').eq('season', season).eq('completed', true).range(a, b)),
    selectAll<any>((a, b) => db().from('pbp_weeks').select('week,season_type,fetched_at').eq('season', season).range(a, b)),
    maxRegularWeek(season),
  ]);
  const done = new Map(fetched.map((f) => [`${f.season_type}|${f.week}`, new Date(f.fetched_at).getTime()]));
  // A week needs (re)fetching if never fetched, or a game in it finished after the last fetch.
  const need = new Map<string, { week: number; type: string; games: any[] }>();
  for (const g of games) {
    const key = `${g.season_type}|${g.week}`;
    if (!need.has(key)) need.set(key, { week: g.week, type: g.season_type, games: [] });
    need.get(key)!.games.push(g);
  }
  const todo = [...need.values()]
    .filter((w) => {
      const last = done.get(`${w.type}|${w.week}`);
      const latestKick = Math.max(...w.games.map((g) => new Date(g.start_date ?? 0).getTime()));
      return last === undefined || last < latestKick + 5 * 3600e3;
    })
    .sort((a, b) => a.week - b.week)
    .slice(0, MAX_WEEKS_PER_RUN);

  let teamGames = 0, plays = 0;
  for (const w of todo) {
    const cfbdWeek = w.type === 'postseason' ? w.week - maxReg : w.week;
    const raw = await cfbd<any[]>('/plays', { year: season, week: cfbdWeek, seasonType: w.type });
    plays += raw.length;
    const byGame = new Map<number, PbpPlay[]>();
    for (const p of raw) {
      const gid = Number(p.gameId ?? p.game_id);
      if (!byGame.has(gid)) byGame.set(gid, []);
      byGame.get(gid)!.push({
        offense: p.offense, defense: p.defense, home: p.home, period: Number(p.period),
        offenseScore: Number(p.offenseScore ?? p.offense_score ?? 0), defenseScore: Number(p.defenseScore ?? p.defense_score ?? 0),
        down: Number(p.down), distance: Number(p.distance), yardsGained: Number(p.yardsGained ?? p.yards_gained ?? 0),
        playType: String(p.playType ?? p.play_type ?? ''), ppa: p.ppa === null || p.ppa === undefined || p.ppa === '' ? null : Number(p.ppa),
      });
    }
    const rows: any[] = [];
    for (const g of w.games) {
      const ps = byGame.get(Number(g.id));
      if (!ps?.length) continue;
      for (const a of aggregatePlays(ps)) {
        // Map by home/away instead of by name, so spelling differences can't break it.
        const team = a.offIsHome ? g.home_id : g.away_id, opp = a.offIsHome ? g.away_id : g.home_id;
        if (!team || !opp) continue;
        rows.push({
          game_id: g.id, team_id: team, opp_id: opp, season, week: g.week, is_home: a.offIsHome, neutral: !!g.neutral_site,
          plays: a.plays, epa: round(a.epa, 3), success: a.success, succ_epa: round(a.succEpa, 3),
          rush_plays: a.rushPlays, rush_epa: round(a.rushEpa, 3), pass_plays: a.passPlays, pass_epa: round(a.passEpa, 3),
          fetched_at: new Date().toISOString(),
        });
      }
    }
    await upsertChunked('team_game_pbp', rows, 'game_id,team_id');
    await db().from('pbp_weeks').upsert({ season, week: w.week, season_type: w.type, fetched_at: new Date().toISOString(), games: rows.length / 2 }, { onConflict: 'season,week,season_type' });
    teamGames += rows.length;
  }
  const remaining = [...need.values()].filter((w) => !done.has(`${w.type}|${w.week}`)).length - todo.length;
  return { pbpWeeksFetched: todo.map((w) => w.week), pbpPlays: plays, pbpTeamGames: teamGames, pbpWeeksStillToFetch: Math.max(0, remaining) };
}

/** Rebuild the `tcc_epa` snapshot for every week up to `throughWeek` (each uses only earlier games). */
export async function computePbpRatings(season: number, throughWeek: number) {
  const [rows, teams] = await Promise.all([
    selectAll<any>((a, b) => db().from('team_game_pbp').select('*').eq('season', season).order('game_id').order('team_id').range(a, b)),
    selectAll<any>((a, b) => db().from('teams').select('id,classification').range(a, b)),
  ]);
  const isFbs = new Map(teams.map((t) => [t.id, t.classification === 'fbs']));
  const key = (id: number) => (isFbs.get(id) ? id : FCS);
  const weeks = [...new Set(rows.map((r) => r.week))];
  if (!weeks.length) return { pbpSnapshots: 0 };
  const first = Math.min(...weeks);
  const now = new Date().toISOString();
  const out: any[] = [];
  let snapshots = 0;
  for (let W = first + 1; W <= throughWeek; W++) {
    const prior = rows.filter((r) => r.week < W && r.plays > 0);
    if (prior.length < 60) continue; // need ~30 games before ratings mean anything
    const base = (val: (r: any) => number, wt: (r: any) => number) => prior.map((r) => ({
      off: key(r.team_id), def: key(r.opp_id), value: val(r), weight: wt(r), loc: r.neutral ? 0 : r.is_home ? 1 : -1,
    }));
    const adj = (val: (r: any) => number, wt: (r: any) => number, lambda = LAMBDA_PLAYS) =>
      center(adjustPerPlay(base(val, wt).filter((x) => x.weight > 0), lambda).teams, isFbs);
    const epa = adj((r) => r.epa / r.plays, (r) => r.plays);
    const sr = adj((r) => r.success / r.plays, (r) => r.plays);
    const expl = adj((r) => (r.success ? r.succ_epa / r.success : 0), (r) => r.success, LAMBDA_PLAYS / 2);
    const rush = adj((r) => (r.rush_plays ? r.rush_epa / r.rush_plays : 0), (r) => r.rush_plays, LAMBDA_PLAYS / 2);
    const pass = adj((r) => (r.pass_plays ? r.pass_epa / r.pass_plays : 0), (r) => r.pass_plays, LAMBDA_PLAYS / 2);
    const gamesPlayed = new Map<number, number>();
    for (const r of prior) gamesPlayed.set(r.team_id, (gamesPlayed.get(r.team_id) ?? 0) + 1);
    for (const [id, v] of epa) {
      if (id === FCS) continue;
      const g = (m: Map<number, { o: number; d: number }>) => m.get(id) ?? { o: 0, d: 0 };
      out.push({
        season, week: W, source: 'tcc_epa', team_id: id,
        rating: round(v.o - v.d, 4), offense: round(v.o, 4), defense: round(v.d, 4),
        raw: {
          games: gamesPlayed.get(id) ?? 0,
          sr_o: round(g(sr).o, 4), sr_d: round(g(sr).d, 4), expl_o: round(g(expl).o, 4), expl_d: round(g(expl).d, 4),
          rush_o: round(g(rush).o, 4), rush_d: round(g(rush).d, 4), pass_o: round(g(pass).o, 4), pass_d: round(g(pass).d, 4),
        },
        fetched_at: now,
      });
    }
    snapshots++;
  }
  await upsertChunked('source_ratings', out, 'season,week,source,team_id');
  return { pbpSnapshots: snapshots, pbpTeamGamesUsed: rows.length };
}

/** Express adjusted values relative to the average FBS team. */
function center(m: Map<number, { o: number; d: number }>, isFbs: Map<number, boolean>) {
  const f = [...m.entries()].filter(([id]) => isFbs.get(id));
  const mo = mean(f.map(([, v]) => v.o)), md = mean(f.map(([, v]) => v.d));
  return new Map([...m.entries()].map(([id, v]) => [id, { o: v.o - mo, d: v.d - md }]));
}

function round(v: number, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
