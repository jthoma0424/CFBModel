'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase';
import { JOBS, JobName, runJob } from '@/lib/pipeline';
import { buildPredictions, calibrate } from '@/lib/model/compute';
import { runBlendLab } from '@/lib/model/blend-lab';
import { currentSeason, currentWeek } from '@/lib/season';
import { normalizeName } from '@/lib/names';
import { parseManualCsv } from '@/lib/scrapers/parsers';
import { saveScraped } from '@/lib/scrapers';

// Pages are behind the password middleware, and server actions POST to those
// pages, so these are only reachable when signed in.

export async function runJobAction(form: FormData) {
  const job = String(form.get('job')) as JobName;
  if (!JOBS.includes(job)) throw new Error('bad job');
  const week = Number(form.get('week') || 0);
  const result = await runJob(job, week > 0 ? { week } : {});
  revalidatePath('/', 'layout');
  redirect(`/admin?ran=${job}${week > 0 ? ` (week ${week})` : ''}&ok=${result?.ok ? 1 : 0}`);
}

export async function saveSettings(form: FormData) {
  const n = (k: string) => Number(form.get(k));
  const res = await db().from('model_settings').update({
    hfa: n('hfa'), sigma: n('sigma'), edge_threshold: n('edge_threshold'),
    margin_cap: n('margin_cap'), prior_weight: n('prior_weight'), default_price: n('default_price'),
    total_sigma: n('total_sigma'), total_edge_threshold: n('total_edge_threshold'), points_cap: n('points_cap'),
    pace_weight: n('pace_weight'), margin_slope: n('margin_slope') || 1, points_slope: n('points_slope') || 1,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (res.error) redirect(`/admin?error=${encodeURIComponent('Settings not saved: ' + res.error.message + ' (open /check to see which database update is missing)')}`);
  // Re-flag this week's games right away with the new thresholds (no outside API calls).
  const season = currentSeason();
  const { week } = await currentWeek(season);
  await buildPredictions(season, week);
  revalidatePath('/', 'layout');
  redirect('/admin?saved=settings and re-flagged this week');
}

export async function saveSources(form: FormData) {
  const keys = form.getAll('key').map(String);
  for (const key of keys) {
    const res = await db().from('rating_sources').update({
      weight: Number(form.get(`weight_${key}`)),
      scale: Number(form.get(`scale_${key}`)),
      enabled: form.get(`enabled_${key}`) === 'on',
      ...(form.has(`total_weight_${key}`) ? { total_weight: String(form.get(`total_weight_${key}`)).trim() === '' ? null : Number(form.get(`total_weight_${key}`)) } : {}),
    }).eq('key', key);
    if (res.error) redirect(`/admin?error=${encodeURIComponent('Sources not saved: ' + res.error.message)}`);
  }
  redirect('/admin?saved=sources');
}

export async function calibrateAction() {
  const r = await calibrate(currentSeason());
  await db().from('job_runs').insert({ job: 'calibrate', status: r.ok ? 'ok' : 'error', finished_at: new Date().toISOString(), detail: r });
  redirect('/admin?calibrated=1');
}

export async function applyCalibration(form: FormData) {
  const detail = JSON.parse(String(form.get('detail')));
  for (const [key, w] of Object.entries(detail.weights as Record<string, number>)) {
    await db().from('rating_sources').update({ weight: w }).eq('key', key);
  }
  await db().from('model_settings').update({ hfa: detail.hfa, sigma: detail.sigma }).eq('id', 1);
  redirect('/admin?saved=calibration');
}

// ---------------------------------------------------------------------------
// Blend lab
// ---------------------------------------------------------------------------
const NEEDS_0006 = 'Run supabase/migrations/0006_blend.sql in the Supabase SQL Editor first.';

export async function runBlendLabAction() {
  let r: any;
  try { r = await runBlendLab(currentSeason()); } catch (e: any) { r = { ok: false, message: e?.message ?? String(e) }; }
  await db().from('job_runs').insert({ job: 'blend_lab', status: r.ok ? 'ok' : 'error', finished_at: new Date().toISOString(), detail: r });
  redirect('/admin/blend');
}

async function rebuildAfterWeightChange(msg: string) {
  const result = await runJob('model');
  revalidatePath('/', 'layout');
  redirect(`/admin/blend?saved=${encodeURIComponent(msg + (result?.ok ? ' and rebuilt this week\'s ratings and predictions' : ' (rebuild failed, see Admin job log)'))}`);
}

/** Save what the latest Blend lab run recommends (spreads, totals, or both). */
export async function applyBlend(form: FormData) {
  const part = String(form.get('part')); // 'spreads' | 'totals'
  const { data } = await db().from('job_runs').select('detail').eq('job', 'blend_lab').eq('status', 'ok').order('started_at', { ascending: false }).limit(1);
  const a = data?.[0]?.detail?.apply;
  if (!a) redirect('/admin/blend?error=' + encodeURIComponent('Run the blend test first.'));
  if (part === 'spreads') {
    for (const [key, w] of Object.entries(a.weights as Record<string, number>)) await db().from('rating_sources').update({ weight: w }).eq('key', key);
    const res = await db().from('model_settings').update({ hfa: a.hfa, sigma: a.sigma, margin_slope: a.margin_slope }).eq('id', 1);
    if (res.error) redirect('/admin/blend?error=' + encodeURIComponent(NEEDS_0006));
    await rebuildAfterWeightChange('Applied spread weights');
  } else if (part === 'totals' && a.total_weights) {
    for (const [key, w] of Object.entries(a.total_weights as Record<string, number>)) {
      const res = await db().from('rating_sources').update({ total_weight: w }).eq('key', key);
      if (res.error) redirect('/admin/blend?error=' + encodeURIComponent(NEEDS_0006));
    }
    const res = await db().from('model_settings').update({ points_slope: a.points_slope, ...(a.total_sigma ? { total_sigma: a.total_sigma } : {}) }).eq('id', 1);
    if (res.error) redirect('/admin/blend?error=' + encodeURIComponent(NEEDS_0006));
    await rebuildAfterWeightChange('Applied totals weights');
  }
  redirect('/admin/blend');
}

/** Put the original starting weights back. */
export async function resetBlend() {
  const DEFAULTS: Record<string, number> = { sp: 1, fpi: 1, srs: 0.5, elo: 0.5, wepa: 1, sagarin: 1, fei: 0.75, tcc_mov: 1, manual: 0 };
  for (const [key, w] of Object.entries(DEFAULTS)) {
    const res = await db().from('rating_sources').update({ weight: w, total_weight: null }).eq('key', key);
    if (res.error) await db().from('rating_sources').update({ weight: w }).eq('key', key); // before 0006
  }
  await db().from('model_settings').update({ margin_slope: 1, points_slope: 1 }).eq('id', 1);
  await rebuildAfterWeightChange('Reset to the original weights');
}

export async function mapAlias(form: FormData) {
  const raw = String(form.get('raw_name'));
  const source = String(form.get('source'));
  const teamId = Number(form.get('team_id'));
  if (!teamId) redirect('/admin');
  await db().from('team_aliases').upsert({ alias: normalizeName(raw), team_id: teamId, source: 'manual' }, { onConflict: 'alias' });
  await db().from('unmatched_names').update({ resolved: true }).eq('source', source).eq('raw_name', raw);
  redirect('/admin?saved=alias');
}

export async function ignoreAlias(form: FormData) {
  await db().from('unmatched_names').update({ resolved: true }).eq('source', String(form.get('source'))).eq('raw_name', String(form.get('raw_name')));
  redirect('/admin');
}

export async function importManual(form: FormData) {
  const source = String(form.get('source') || 'manual');
  const items = parseManualCsv(String(form.get('csv') ?? ''));
  const season = currentSeason();
  const { week } = await currentWeek(season);
  const r = await saveScraped(source, season, week, items);
  await db().from('job_runs').insert({ job: `import:${source}`, status: 'ok', finished_at: new Date().toISOString(), detail: r });
  redirect('/admin?saved=import');
}

export async function addBet(form: FormData) {
  const gameId = Number(form.get('game_id'));
  const market = form.get('market') === 'total' ? 'total' : 'spread';
  await db().from('bets').insert({
    game_id: gameId,
    market,
    side: market === 'total' ? (form.get('side') === 'under' ? 'under' : 'over') : null,
    team_id: market === 'total' ? null : Number(form.get('team_id')),
    spread: Number(form.get('spread')),
    price: Number(form.get('price') || -110),
    stake: Number(form.get('stake') || 1),
    book: String(form.get('book') || 'draftkings'),
    notes: String(form.get('notes') || '') || null,
  });
  redirect('/bets');
}

export async function deleteBet(form: FormData) {
  await db().from('bets').delete().eq('id', Number(form.get('id')));
  revalidatePath('/bets');
}

// ---------------------------------------------------------------------------
// Manual team adjustments (both sports)
// ---------------------------------------------------------------------------
async function rebuildFor(sport: string) {
  if (sport === 'cbb') {
    const { cbbCurrentSeason } = await import('@/lib/cbb/ingest');
    const { buildCbbPredictions } = await import('@/lib/cbb/model');
    await buildCbbPredictions(await cbbCurrentSeason());
  } else {
    const season = currentSeason();
    const { week } = await currentWeek(season);
    await buildPredictions(season, week);
  }
}

export async function addAdjustment(form: FormData) {
  const sport = form.get('sport') === 'cbb' ? 'cbb' : 'cfb';
  const back = sport === 'cbb' ? '/cbb/admin' : '/admin';
  const teamId = Number(form.get('team_id')), points = Number(form.get('points'));
  if (!teamId || !Number.isFinite(points) || points === 0) redirect(`${back}?error=${encodeURIComponent('Pick a team and enter a non-zero number of points.')}#adjustments`);
  const res = await db().from('team_adjustments').insert({
    sport, team_id: teamId, points,
    note: String(form.get('note') || '') || null,
    start_date: String(form.get('start_date') || '') || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    end_date: String(form.get('end_date') || '') || null,
  });
  if (res.error) redirect(`${back}?error=${encodeURIComponent('Adjustment not saved: ' + res.error.message + ' (run 0005_adjustments.sql in Supabase)')}#adjustments`);
  await rebuildFor(sport);
  revalidatePath('/', 'layout');
  redirect(`${back}?saved=adjustment and re-ran predictions#adjustments`);
}

export async function deleteAdjustment(form: FormData) {
  const sport = form.get('sport') === 'cbb' ? 'cbb' : 'cfb';
  await db().from('team_adjustments').delete().eq('id', Number(form.get('id')));
  await rebuildFor(sport);
  revalidatePath('/', 'layout');
  redirect(`${sport === 'cbb' ? '/cbb/admin' : '/admin'}?saved=removed adjustment#adjustments`);
}
