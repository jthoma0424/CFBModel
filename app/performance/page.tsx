import { db, selectAll } from '@/lib/supabase';
import { currentSeason } from '@/lib/season';
import { betProfit, breakEven } from '@/lib/model/math';
import { Empty, Stat } from '../components';
import { fmtNum, fmtPct, fmtSigned, signClass } from '@/lib/format';

export const dynamic = 'force-dynamic';

type P = { week: number; edge: number; ats_result: string; is_play: boolean; model_margin: number; book_home_spread: number; actual_margin: number; book_home_price: number; book_away_price: number; pick_team_id: number; games: { home_id: number } };

function summarize(rows: P[]) {
  const w = rows.filter((r) => r.ats_result === 'win').length;
  const l = rows.filter((r) => r.ats_result === 'loss').length;
  const pu = rows.filter((r) => r.ats_result === 'push').length;
  const units = rows.reduce((s, r) => {
    const price = r.pick_team_id === r.games.home_id ? r.book_home_price : r.book_away_price;
    return s + betProfit(r.ats_result as any, 1, price ?? -110);
  }, 0);
  return { w, l, pu, n: w + l, pct: w + l ? w / (w + l) : null, units, roi: rows.length ? units / rows.length : null };
}

export default async function Performance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const season = sp.season ? Number(sp.season) : currentSeason();
  const rows: P[] = await selectAll<any>((a, b) =>
    db().from('predictions').select('week,edge,ats_result,is_play,model_margin,book_home_spread,actual_margin,book_home_price,book_away_price,pick_team_id,games!inner(home_id)')
      .eq('season', season).not('ats_result', 'is', null).range(a, b),
  );
  const all = summarize(rows);
  const plays = summarize(rows.filter((r) => r.is_play));
  const be = breakEven(-110);

  // Accuracy vs. the market: mean absolute error of model and line against the final margin
  const maeModel = rows.reduce((s, r) => s + Math.abs(r.actual_margin - r.model_margin), 0) / (rows.length || 1);
  const maeLine = rows.reduce((s, r) => s + Math.abs(r.actual_margin + Number(r.book_home_spread)), 0) / (rows.length || 1);

  const buckets: [string, number, number][] = [['0–1.5', 0, 1.5], ['1.5–3', 1.5, 3], ['3–5', 3, 5], ['5–7', 5, 7], ['7+', 7, 999]];
  const weeks = [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b);

  return (
    <>
      <h1>Model performance · {season}</h1>
      <p className="sub">Graded against the line the model saw at kickoff. Break-even at -110 is {fmtPct(be)}.</p>
      {!rows.length ? <Empty>No graded predictions yet. They appear after games with a captured line go final.</Empty> : (
        <>
          <div className="stats">
            <Stat k="All picks ATS" v={`${all.w}-${all.l}${all.pu ? `-${all.pu}` : ''}`} />
            <Stat k="All picks win %" v={fmtPct(all.pct)} cls={all.pct && all.pct > be ? 'pos' : 'neg'} />
            <Stat k="Plays ATS" v={`${plays.w}-${plays.l}${plays.pu ? `-${plays.pu}` : ''}`} />
            <Stat k="Plays units (1u flat)" v={fmtSigned(plays.units, 2)} cls={signClass(plays.units)} />
            <Stat k="Model MAE" v={fmtNum(maeModel, 2)} />
            <Stat k="Line MAE" v={fmtNum(maeLine, 2)} />
          </div>
          <div className="grid">
            <div>
              <h2>By edge size</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>Edge</th><th className="n">Record</th><th className="n">Win %</th><th className="n">Units</th><th className="n">ROI</th></tr></thead>
                <tbody>
                  {buckets.map(([label, lo, hi]) => {
                    const s = summarize(rows.filter((r) => r.edge >= lo && r.edge < hi));
                    return (
                      <tr key={label}><td>{label}</td><td className="n">{s.w}-{s.l}{s.pu ? `-${s.pu}` : ''}</td>
                        <td className={`n ${s.pct && s.pct > be ? 'pos' : 'neg'}`}>{fmtPct(s.pct)}</td>
                        <td className={`n ${signClass(s.units)}`}>{fmtSigned(s.units, 2)}</td>
                        <td className={`n ${signClass(s.roi)}`}>{s.roi != null ? fmtSigned(s.roi * 100, 1) + '%' : '—'}</td></tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
            <div>
              <h2>By week (plays)</h2>
              <div className="tablewrap"><table>
                <thead><tr><th>Week</th><th className="n">Plays</th><th className="n">Win %</th><th className="n">Units</th><th className="n">All picks</th></tr></thead>
                <tbody>
                  {weeks.map((w) => {
                    const wr = rows.filter((r) => r.week === w);
                    const s = summarize(wr.filter((r) => r.is_play)), a = summarize(wr);
                    return (
                      <tr key={w}><td>{w}</td><td className="n">{s.w}-{s.l}{s.pu ? `-${s.pu}` : ''}</td><td className="n">{fmtPct(s.pct)}</td>
                        <td className={`n ${signClass(s.units)}`}>{fmtSigned(s.units, 2)}</td><td className="n muted">{a.w}-{a.l}</td></tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
