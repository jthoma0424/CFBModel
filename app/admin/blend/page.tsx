import { db } from '@/lib/supabase';
import { getSettings, getSources } from '@/lib/model/compute';
import { applyBlend, resetBlend, runBlendLabAction } from '../../actions';
import { fmtKick } from '@/lib/format';
import { RunButton } from '../run-button';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NAMES: Record<string, string> = {
  sp: 'SP+', fpi: 'FPI', srs: 'SRS', elo: 'Elo', wepa: 'Adj. EPA', sagarin: 'Sagarin', fei: 'FEI', tcc_mov: 'In-house MOV', manual: 'Manual',
};
const rec = (r?: { w: number; l: number; p: number } | null) => (r ? `${r.w}-${r.l}${r.p ? `-${r.p}` : ''}` : '—');
const pct = (r?: { w: number; l: number } | null) => (r && r.w + r.l ? `${Math.round((100 * r.w) / (r.w + r.l))}%` : '');
const f = (v: any, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

export default async function BlendLab({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const [settings, sources, runRes] = await Promise.all([
    getSettings(), getSources(),
    db().from('job_runs').select('*').eq('job', 'blend_lab').order('started_at', { ascending: false }).limit(1),
  ]);
  const run = runRes.data?.[0];
  const d = run?.detail;
  const m = d?.margin, p = d?.points, t = d?.totals, a = d?.apply;
  const lineRow = m?.candidates?.find((c: any) => c.isLine);
  const cur = m?.candidates?.[0], fit = m?.candidates?.[2];
  const fitBeatsCur = fit && cur && fit.rmse < cur.rmse;

  return (
    <>
      <h1>Blend lab</h1>
      <p className="sub">
        <a href="/admin">← Admin</a> · Tests each rating source, and blends of them, against what actually happened.
        Ratings are rebuilt for each week as they stood <b>before kickoff</b>, so nothing peeks at the result.
      </p>
      {sp.saved && <div className="card pos" style={{ marginBottom: 12 }}>{sp.saved}.</div>}
      {sp.error && <div className="card neg" style={{ marginBottom: 12 }}>{sp.error}</div>}

      <div className="card inline" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <form action={runBlendLabAction}><RunButton label="Run blend test" primary /></form>
        <span className="muted">Takes 10–60 seconds. {run ? `Last run ${fmtKick(run.started_at)}${d?.weeks ? ` · weeks ${d.weeks[0]}–${d.weeks[d.weeks.length - 1]}` : ''}.` : 'Not run yet.'}</span>
        <form action={resetBlend} style={{ marginLeft: 'auto' }}><button type="submit" className="secondary">Reset to original weights</button></form>
      </div>
      <p className="sub" style={{ marginTop: 6 }}>
        Now using: spread slope {f(settings.margin_slope)}, points slope {f(settings.points_slope)}, HFA {f(settings.hfa, 1)} ·
        weights {sources.filter((s) => s.enabled && s.weight > 0).map((s) => `${s.key} ${s.weight}`).join(', ')}
      </p>

      {d && !d.ok && <div className="card warn">{d.message}</div>}

      {d?.ok && (
        <>
          <h2>Spreads: predicting the final margin</h2>
          <div className="card callout" style={{ marginBottom: 10 }}>
            <Verdict cur={cur} fit={fit} line={lineRow} />
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>Method</th><th className="n">Games</th><th className="n">Avg miss (RMSE)</th><th className="n">Avg miss (abs)</th>
                <th className="n">Plays vs DK (edge ≥ {m.threshold})</th><th className="n" title="0 = adds nothing beyond the DK line; 1 = fully trustworthy disagreements">Beyond-line score</th>
              </tr></thead>
              <tbody>
                {m.candidates.map((c: any) => (
                  <tr key={c.name} className={c.isLine ? 'muted' : ''}>
                    <td>{c.name}</td><td className="n">{c.n}</td><td className="n">{f(c.rmse)}</td><td className="n">{f(c.mae)}</td>
                    <td className="n">{c.isLine ? '' : `${rec(c.record)} ${pct(c.record)}`}</td>
                    <td className={`n ${c.beyondLine >= 0.4 ? 'pos' : c.beyondLine <= 0.1 ? 'neg' : ''}`}>{c.isLine ? '' : f(c.beyondLine)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub" style={{ marginTop: 6 }}>
            Lower miss is better. <b>Beyond-line score</b>: when the method disagreed with DraftKings, what fraction of that disagreement showed up in the result.
            Near 0 means the disagreements were noise; 0.5 means half of each edge was real.{!m.onLineGames && ' (Not enough games with a stored DK line yet, so misses use all games.)'}
          </p>

          <h3>Each source on its own</h3>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>Source</th><th className="n">Games</th><th className="n" title="Regression of actual margin on this source's predicted margin. 1.0 = right size; below 1 = too spread out">Slope</th>
                <th className="n">Correlation</th><th className="n">Avg miss</th><th className="n">Plays vs DK</th><th className="n">Current weight</th><th className="n">Fitted share</th>
              </tr></thead>
              <tbody>
                {[...m.perSource].sort((x: any, y: any) => (x.rmse ?? 99) - (y.rmse ?? 99)).map((s: any) => (
                  <tr key={s.key}>
                    <td>{NAMES[s.key] ?? s.key}</td><td className="n">{s.n}</td>
                    <td className={`n ${s.slope !== null && Math.abs(s.slope - 1) > 0.25 ? 'warn' : ''}`}>{f(s.slope)}</td>
                    <td className="n">{f(s.corr)}</td><td className="n">{f(s.rmse)}</td>
                    <td className="n">{s.record ? `${rec(s.record)} ${pct(s.record)}` : '—'}</td>
                    <td className="n">{s.currentWeight}</td>
                    <td className="n">{s.fittedShare === null ? <span className="muted">too little data</span> : `${Math.round(s.fittedShare * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub" style={{ marginTop: 6 }}>
            <b>Slope</b> near 1.0 means a source&apos;s point gaps are the right size. Below 1 means its gaps are too big, so
            the actual margins were smaller than it predicted. That inflates edges.
          </p>

          <div className="card">
            <b>Apply the fitted spread blend?</b>
            <div className="muted" style={{ margin: '6px 0 10px' }}>
              Weights {Object.entries(a.weights).map(([k, w]) => `${NAMES[k] ?? k} ${w}`).join(', ')} · spread slope {a.margin_slope} · HFA {a.hfa} · σ {a.sigma}
            </div>
            {!fitBeatsCur && <div className="warn" style={{ marginBottom: 8 }}>The fitted blend did not beat your current blend on held-out weeks, so keep what you have.</div>}
            <form action={applyBlend}><input type="hidden" name="part" value="spreads" /><RunButton label="Apply spread blend" primary={!!fitBeatsCur} /></form>
          </div>

          {p?.ok && (
            <>
              <h2>Totals: predicting points each team scored</h2>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Method</th><th className="n">Team-games</th><th className="n">Avg miss (RMSE)</th><th className="n">Avg miss (abs)</th></tr></thead>
                  <tbody>
                    {p.candidates.map((c: any) => (
                      <tr key={c.name} className={c.isLine ? 'muted' : ''}>
                        <td>{c.isLine ? 'DraftKings implied team total' : c.name}</td><td className="n">{c.n}</td><td className="n">{f(c.rmse)}</td><td className="n">{f(c.mae)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Offense/defense sources on their own</h3>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Source</th><th className="n">Team-games</th><th className="n">Slope</th><th className="n">Correlation</th><th className="n">Avg miss</th><th className="n">Fitted share</th></tr></thead>
                  <tbody>
                    {p.perSource.map((s: any) => (
                      <tr key={s.key}>
                        <td>{NAMES[s.key] ?? s.key}</td><td className="n">{s.n}</td>
                        <td className={`n ${s.slope !== null && Math.abs(s.slope - 1) > 0.25 ? 'warn' : ''}`}>{f(s.slope)}</td>
                        <td className="n">{f(s.corr)}</td><td className="n">{f(s.rmse)}</td>
                        <td className="n">{s.fittedShare === null ? '—' : `${Math.round(s.fittedShare * 100)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {t && (
                <p className="sub" style={{ marginTop: 6 }}>
                  Game totals ({t.gamesWithLine} games with a DK total, no pace): current blend misses by {f(t.lineSameGames.current)}, fitted {f(t.lineSameGames.fitted)}, DraftKings {f(t.line.rmse)}.
                  Plays at edge ≥ {t.threshold}: current {rec(t.current.record)} {pct(t.current.record)}, fitted {rec(t.fitted.record)} {pct(t.fitted.record)}.
                </p>
              )}
              <div className="card">
                <b>Apply the fitted totals blend?</b>
                <div className="muted" style={{ margin: '6px 0 10px' }}>
                  Totals weights {Object.entries(a.total_weights ?? {}).map(([k, w]) => `${NAMES[k] ?? k} ${w}`).join(', ')} · points slope {a.points_slope} · totals σ {a.total_sigma ?? '—'}
                </div>
                <form action={applyBlend}><input type="hidden" name="part" value="totals" /><RunButton label="Apply totals blend" /></form>
              </div>
            </>
          )}
          {p && !p.ok && <p className="sub">Totals: {p.message}</p>}
        </>
      )}
    </>
  );
}

function Verdict({ cur, fit, line }: { cur: any; fit: any; line: any }) {
  if (!cur || !fit) return null;
  const best = fit.rmse < cur.rmse ? fit : cur;
  const parts: string[] = [];
  parts.push(`${best === fit ? 'The fitted blend' : 'Your current blend'} is the best of the model versions here, missing by ${best.rmse} points on average.`);
  if (line) {
    const gap = Math.round((best.rmse - line.rmse) * 100) / 100;
    parts.push(gap > 0
      ? `DraftKings missed by ${line.rmse}, so the line is still ${gap} points more accurate.`
      : `That beats the DraftKings line (${line.rmse}).`);
  }
  if (best.beyondLine !== undefined && best.beyondLine !== null) {
    parts.push(best.beyondLine <= 0.1
      ? `Its beyond-line score is ${best.beyondLine}: when it disagreed with DK, the disagreement mostly didn't show up in the result. Treat plays with a lot of caution and use a higher threshold.`
      : best.beyondLine < 0.4
        ? `Its beyond-line score is ${best.beyondLine}: only part of each edge has been real, so a 3-point edge is worth about ${Math.round(3 * best.beyondLine * 10) / 10} points. Raise the play threshold.`
        : `Its beyond-line score is ${best.beyondLine}: its disagreements with DK have mostly held up.`);
  }
  return <>{parts.join(' ')}</>;
}
