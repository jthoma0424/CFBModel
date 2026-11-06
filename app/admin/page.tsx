import { db } from '@/lib/supabase';
import { currentSeason, currentWeek } from '@/lib/season';
import { OD_SOURCES, getSettings, getSources } from '@/lib/model/compute';
import { teamMap } from '@/lib/queries';
import { ignoreAlias, importManual, mapAlias, runJobAction, saveSettings, saveSources } from '../actions';
import { fmtKick } from '@/lib/format';
import { RunButton } from './run-button';
import { AdjustmentsPanel } from '../adjustments-panel';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const JOB_HELP: [string, string][] = [
  ['setup', 'Teams, name aliases, calendar, schedule. Run once per season.'],
  ['cfbd', 'Scores + SP+, FPI, SRS, Elo, adjusted EPA, advanced stats, CFBD lines.'],
  ['pbp', 'Play-by-play → in-house EPA ratings (1 CFBD call per new week; first run backfills 4 weeks at a time).'],
  ['scrape', 'Sagarin Predictor, FEI.'],
  ['odds', 'DraftKings spreads + totals (2 Odds API credits).'],
  ['model', 'Grade results, rebuild power ratings, update predictions.'],
  ['daily', 'cfbd + pbp + scrape + odds + model in sequence.'],
];

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const season = currentSeason();
  const [{ week }, settings, sources, teams, runsRes, unmatchedRes] = await Promise.all([
    currentWeek(season), getSettings(), getSources(), teamMap(),
    db().from('job_runs').select('*').order('started_at', { ascending: false }).limit(15),
    db().from('unmatched_names').select('*').eq('resolved', false).order('last_seen', { ascending: false }).limit(50),
  ]);
  const fbs = [...teams.values()].filter((t) => t.classification === 'fbs' || t.classification === 'fcs').sort((a, b) => a.school.localeCompare(b.school));

  return (
    <>
      <h1>Admin</h1>
      <p className="sub">Season {season} · model week {week}{sp.ran ? ` · ran ${sp.ran}: ${sp.ok === '1' ? 'ok' : 'error (see log)'}` : ''}{sp.saved ? ` · saved ${sp.saved}` : ''}</p>
      {sp.error && <div className="card neg" style={{ marginBottom: 12 }}>{sp.error}</div>}

      <h2>Run jobs</h2>
      <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {JOB_HELP.map(([job, help]) => (
          <form key={job} action={runJobAction} title={help}>
            <input type="hidden" name="job" value={job} />
            <RunButton label={job[0].toUpperCase() + job.slice(1)} primary={job === 'daily'} />
          </form>
        ))}
      </div>
      <p className="sub" style={{ marginTop: 6 }}>{JOB_HELP.map(([j, h]) => `${j}: ${h}`).join('  ·  ')}</p>
      <form action={runJobAction} className="card inline" style={{ marginTop: 8 }}>
        <span className="muted">Run for a specific week:</span>
        <select name="job" defaultValue="daily">
          <option value="daily">Daily</option>
          <option value="model">Model</option>
          <option value="cfbd">Cfbd</option>
          <option value="pbp">Pbp</option>
          <option value="odds">Odds</option>
        </select>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>Week<input name="week" type="number" min="1" max="20" defaultValue={week} style={{ width: 70 }} /></label>
        <RunButton label="Run" />
        <span className="muted">The model normally moves to the next week by itself once the current week's last game kicks off.</span>
      </form>

      <AdjustmentsPanel sport="cfb" teams={[...teams.values()].filter((t) => t.classification === 'fbs').sort((a, b) => a.school.localeCompare(b.school))} />

      <h2>Recent job runs</h2>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Job</th><th>Started</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            {(runsRes.data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.job}</td><td className="muted">{fmtKick(r.started_at)}</td>
                <td className={r.status === 'ok' ? 'pos' : r.status === 'error' ? 'neg' : 'muted'}>{r.status ?? 'running'}</td>
                <td><pre className="small">{JSON.stringify(r.detail)?.slice(0, 600)}</pre></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid">
        <div>
          <h2>Model settings</h2>
          <form action={saveSettings} className="card formgrid">
            <label>Home-field adv. (pts)<input name="hfa" type="number" step="0.1" defaultValue={settings.hfa} /></label>
            <label>σ of margin (pts)<input name="sigma" type="number" step="0.1" defaultValue={settings.sigma} /></label>
            <label>Play threshold (pts)<input name="edge_threshold" type="number" step="0.5" defaultValue={settings.edge_threshold} /></label>
            <label>MOV cap (pts)<input name="margin_cap" type="number" step="1" defaultValue={settings.margin_cap} /></label>
            <label>Prior weight (games)<input name="prior_weight" type="number" step="0.5" defaultValue={settings.prior_weight} /></label>
            <label>Default price<input name="default_price" type="number" defaultValue={settings.default_price} /></label>
            <label>Totals σ (pts)<input name="total_sigma" type="number" step="0.1" defaultValue={settings.total_sigma} /></label>
            <label>Totals play threshold<input name="total_edge_threshold" type="number" step="0.5" defaultValue={settings.total_edge_threshold} /></label>
            <label>Points cap (pts)<input name="points_cap" type="number" step="1" defaultValue={settings.points_cap} /></label>
            <label>Pace weight (0 = off)<input name="pace_weight" type="number" step="0.1" min="0" max="1.5" defaultValue={settings.pace_weight} /></label>
            <label>Spread slope (1 = off)<input name="margin_slope" type="number" step="0.01" min="0.3" max="1.5" defaultValue={settings.margin_slope} /></label>
            <label>Points slope (1 = off)<input name="points_slope" type="number" step="0.01" min="0.3" max="1.5" defaultValue={settings.points_slope} /></label>
            <button type="submit">Save</button>
          </form>
        </div>
        <div>
          <h2>Test &amp; fit weights</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              The <b>Blend lab</b> rebuilds each past week&apos;s ratings as they stood before kickoff and checks how well every source,
              and every blend of them, predicted actual margins and points scored, next to the DraftKings line. It can then save a better blend.
            </p>
            <a className="button" href="/admin/blend">Open Blend lab →</a>
          </div>
        </div>
      </div>

      <h2>Rating sources</h2>
      <form action={saveSources}>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Key</th><th>Name</th><th>Origin</th><th className="n">Scale (→ pts)</th><th className="n">Weight</th><th className="n" title="Weight for offense/defense ratings used in totals. Blank = same as Weight.">Totals weight</th><th>On</th><th>Notes</th></tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.key}>
                  <td><input type="hidden" name="key" value={s.key} />{s.key}</td>
                  <td>{s.name}</td><td className="muted">{s.origin}</td>
                  <td className="n"><input name={`scale_${s.key}`} type="number" step="0.01" defaultValue={s.scale} style={{ width: 80 }} /></td>
                  <td className="n"><input name={`weight_${s.key}`} type="number" step="0.05" defaultValue={s.weight} style={{ width: 80 }} /></td>
                  <td className="n">{OD_SOURCES.includes(s.key)
                    ? <input name={`total_weight_${s.key}`} type="number" step="0.05" defaultValue={s.total_weight ?? ''} placeholder="same" style={{ width: 80 }} />
                    : <span className="muted">—</span>}</td>
                  <td><input name={`enabled_${s.key}`} type="checkbox" defaultChecked={s.enabled} /></td>
                  <td className="muted">{(s as any).notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="submit" style={{ marginTop: 10 }}>Save sources</button>
      </form>

      <div className="grid">
        <div>
          <h2>Unmatched team names ({unmatchedRes.data?.length ?? 0})</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Source</th><th>Name</th><th>Map to</th><th></th></tr></thead>
              <tbody>
                {(unmatchedRes.data ?? []).map((u) => (
                  <tr key={u.source + u.raw_name}>
                    <td className="muted">{u.source}</td><td>{u.raw_name}</td>
                    <td>
                      <form action={mapAlias} className="inline">
                        <input type="hidden" name="raw_name" value={u.raw_name} />
                        <input type="hidden" name="source" value={u.source} />
                        <select name="team_id" defaultValue="">
                          <option value="">Choose team…</option>
                          {fbs.map((t) => <option key={t.id} value={t.id}>{t.school}</option>)}
                        </select>
                        <button type="submit" className="secondary">Map</button>
                      </form>
                    </td>
                    <td>
                      <form action={ignoreAlias}>
                        <input type="hidden" name="raw_name" value={u.raw_name} />
                        <input type="hidden" name="source" value={u.source} />
                        <button type="submit" className="danger">ignore</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {!unmatchedRes.data?.length && <tr><td colSpan={4} className="muted">All names matched.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2>Import ratings from any site</h2>
          <form action={importManual} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label>Save into source
              <select name="source" defaultValue="manual">
                {sources.map((s) => <option key={s.key} value={s.key}>{s.key} — {s.name}</option>)}
              </select>
            </label>
            <textarea name="csv" placeholder={'Paste "Team, Rating" rows (CSV or tab-separated, e.g. copied from a ratings table)\nGeorgia, 27.4\nOhio State, 26.1'} />
            <button type="submit">Import</button>
            <span className="muted">Give the &quot;manual&quot; source a weight above 0 to blend it in. Add more sources by inserting rows into rating_sources.</span>
          </form>
        </div>
      </div>
    </>
  );
}
