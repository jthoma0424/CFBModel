import { db } from './supabase';
export { OFFENSE_SHARE, adjustmentFor, applyAdjustments } from './model/math';

import type { Adjustment } from './model/math';
export type { Adjustment };

/** Load adjustments for a sport. Returns [] if the table doesn't exist yet (0005 not run). */
export async function loadAdjustments(sport: 'cfb' | 'cbb'): Promise<Adjustment[]> {
  const { data, error } = await db().from('team_adjustments').select('*').eq('sport', sport);
  if (error) return [];
  return (data ?? []).map((a) => ({ ...a, points: Number(a.points) }));
}

