import Link from 'next/link';
import { db, selectAll } from '@/lib/supabase';
import { resolveWeek, teamMap } from '@/lib/queries';
import { getSettings } from '@/lib/model/compute';
import { Empty, Stat, Team, WeekPicker } from './components';
import { fmtKick, fmtNum, fmtPct, fmtPrice, fmtSigned, fmtSpread, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Slate({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const { season, week, weeks } = await resolveWeek(sp);
  const playsOnly = sp.plays === '1';
  const sort = sp.sort ?? 'edge';
  const [teams, settings] = await Promise.all([teamMap(), getSettings()]);

  const games = await selectAll<any>((a, b) => db().from('games').select('*').eq('season', season).eq('week', week).range(a, b));
  const preds = await selectAll<any>((a, b) => db().from('predictions').select('*').eq('season', season).eq('week', week).range(a, b));
  const pmap = new Map(preds.map((p) => [p.game_id, p]));

  let rows = games.map((g) => ({ g, p: pmap.get(g.id) }));
  if (playsOnly) rows = rows.filter((r) => r.p?.is_play);
  rows.sort((a, b) => {
    if (sort === 'time') return String(a.g.start_date).localeCompare(String(b.g.start_date));
    return (b.p?.edge ?? -99) - (a.p?.edge ?? -99);
  });

  const withLine = preds.filter((p) => p.book_home_spread !== null);
  const plays = preds.filter((p) => p.is_play);
  const graded = preds.filter((p) => p.is_play && p.ats_result);
  const wins = graded.filter((p) => p.ats_result === 'win').length;
  const losses = graded.filter((p) => p.ats_result === 'loss').length;

  return (
    <>
      <h1>Week {week} slate</h1>
      <p className="sub">
        Model spread vs. DraftKings. Plays are flagged at ≥ {settings.edge_threshold} pts of edge · HFA {settings.hfa} · σ {settings.sigma}
      </p>
      <div className="stats">
        <Stat k="Games" v={games.length} />
        <Stat k="With DK line" v={withLine.length} />
        <Stat k="Plays" v={plays.length} />
        <Stat k="Plays ATS (this week)" v={graded.length ? `${wins}-${losses}` : '—'} />
      </div>
      <WeekPicker
        season={season} week={week} weeks={weeks} path="/"
        extra={
          <>
            <label>Show<select name="plays" defaultValue={playsOnly ? '1' : '0'}><option value="0">All games</option><option value="1">Plays only</option></select></label>
            <label>Sort<select name="sort" defaultValue={sort}><option value="edge">Edge</option><option value="time">Kickoff</option></select></label>
          </>
        }
      />
      {!games.length ? (
        <Empty>No games for this week yet. Go to <Link href="/admin">Admin</Link> and run <b>Setup</b> then <b>Daily</b>.</Empty>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Kickoff (ET)</th><th>Away</th><th>Home</th>
                <th className="n">Away rtg</th><th className="n">Home rtg</th>
                <th className="n">Model (home)</th><th className="n">DK (home)</th>
                <th className="n">Edge</th><th>Pick</th><th className="n">Cover %</th><th className="n">EV/u</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ g, p }) => {
                const pickTeam = p?.pick_team_id ? teams.get(p.pick_team_id) : null;
                return (
                  <tr key={g.id} className={p?.is_play ? 'play' : ''}>
                    <td className="muted">{fmtKick(g.start_date)}{g.neutral_site ? ' · N' : ''}</td>
                    <td><Team t={teams.get(g.away_id)} /></td>
                    <td><Team t={teams.get(g.home_id)} /></td>
                    <td className="n">{fmtNum(p?.away_rating)}</td>
                    <td className="n">{fmtNum(p?.home_rating)}</td>
                    <td className="n"><b>{fmtSpread(p?.model_spread)}</b></td>
                    <td className="n">
                      {fmtSpread(p?.book_home_spread)}{' '}
                      <span className="muted">{fmtPrice(p?.book_home_price)}</span>
                      {p?.book && !p.book.startsWith('draftkings') ? <span className="warn" title={`Line source: ${p.book}`}> *</span> : null}
                    </td>
                    <td className={`n ${signClass(p?.edge)}`}>{fmtSigned(p?.edge)}</td>
                    <td>
                      {pickTeam ? <Link href={`/game/${g.id}`}>{pickTeam.school} {fmtSpread(p.pick_spread)}</Link> : <Link href={`/game/${g.id}`} className="muted">details</Link>}
                      {p?.is_play ? <> <span className="badge play">PLAY</span></> : null}
                    </td>
                    <td className="n">{fmtPct(p?.cover_prob)}</td>
                    <td className={`n ${signClass(p?.ev)}`}>{fmtSigned(p?.ev, 3)}</td>
                    <td>
                      {g.completed ? <span className="muted">{g.away_points}-{g.home_points}</span> : null}{' '}
                      {p?.ats_result ? <span className={`badge ${p.ats_result}`}>{p.ats_result.toUpperCase()}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="sub" style={{ marginTop: 10 }}>
        <span className="warn">*</span> = no live DraftKings line yet; using CFBD's line instead. Predictions lock at kickoff.
      </p>
    </>
  );
}
