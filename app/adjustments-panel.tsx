import { db } from '@/lib/supabase';
import { addAdjustment, deleteAdjustment } from './actions';
import { fmtSigned, signClass } from '@/lib/format';

/** Admin section to add/remove manual team adjustments (injuries, suspensions…). */
export async function AdjustmentsPanel({ sport, teams }: { sport: 'cfb' | 'cbb'; teams: { id: number; school: string }[] }) {
  const { data, error } = await db().from('team_adjustments').select('*').eq('sport', sport).order('start_date', { ascending: false });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const name = new Map(teams.map((t) => [t.id, t.school]));
  const rows = data ?? [];
  const active = (a: any) => a.start_date <= today && (!a.end_date || a.end_date >= today);

  return (
    <div id="adjustments">
      <h2>Manual team adjustments</h2>
      {error ? (
        <div className="card warn">Run <b>supabase/migrations/0005_adjustments.sql</b> in the Supabase SQL Editor to turn on adjustments.</div>
      ) : (
        <>
          <p className="sub" style={{ marginBottom: 8 }}>
            Points added to a team&apos;s rating for games in the date range, e.g. <b>-7</b> for a starting QB out{sport === 'cbb' ? <> or <b>-4</b> for a star guard out</> : null}.
            The spread moves by the full amount; about 70% comes off that team&apos;s projected points and 30% goes to the opponent, so totals move too.
            Saving re-runs this week&apos;s predictions right away. Games already started keep their locked numbers.
          </p>
          <form action={addAdjustment} className="card formgrid">
            <input type="hidden" name="sport" value={sport} />
            <label>Team
              <select name="team_id" defaultValue="" required>
                <option value="">Choose team…</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.school}</option>)}
              </select>
            </label>
            <label>Points (+ stronger / − weaker)<input name="points" type="number" step="0.5" required placeholder="-7" /></label>
            <label>Note<input name="note" placeholder="QB out (ankle)" /></label>
            <label>From<input name="start_date" type="date" defaultValue={today} /></label>
            <label>Until (blank = until removed)<input name="end_date" type="date" /></label>
            <button type="submit">Add adjustment</button>
          </form>
          <div className="tablewrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Team</th><th className="n">Points</th><th>Note</th><th>From</th><th>Until</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>{name.get(a.team_id) ?? a.team_id}</td>
                    <td className={`n ${signClass(Number(a.points))}`}>{fmtSigned(Number(a.points))}</td>
                    <td>{a.note}</td>
                    <td className="muted">{a.start_date}</td>
                    <td className="muted">{a.end_date ?? '—'}</td>
                    <td>{active(a) ? <span className="badge play">ACTIVE</span> : <span className="muted">{a.start_date > today ? 'upcoming' : 'expired'}</span>}</td>
                    <td>
                      <form action={deleteAdjustment}>
                        <input type="hidden" name="id" value={a.id} /><input type="hidden" name="sport" value={sport} />
                        <button type="submit" className="danger">×</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="muted">No adjustments.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
