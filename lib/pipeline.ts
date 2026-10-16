import { runLogged } from './jobs';
import { currentSeason, currentWeek } from './season';
import { syncCalendar, syncCfbdLines, syncGames, syncRatingsAndStats, syncTeams } from './cfbd';
import { syncOdds } from './odds';
import { runScrapers } from './scrapers';
import { buildPredictions, computePowerRatings, gradeAll } from './model/compute';
import { db } from './supabase';

export const JOBS = ['setup', 'cfbd', 'scrape', 'odds', 'model', 'daily'] as const;
export type JobName = (typeof JOBS)[number];

async function ctx() {
  const season = currentSeason();
  const { week } = await currentWeek(season);
  return { season, week };
}

/**
 * setup  – teams, aliases, calendar (run once per season, or when teams look wrong)
 * cfbd   – games/scores, CFBD ratings + advanced stats, CFBD lines
 * scrape – Sagarin, FEI and any other registered scrapers
 * odds   – DraftKings spreads from The Odds API
 * model  – power ratings -> predictions -> grading
 * daily  – everything except setup (setup runs automatically if teams are empty)
 */
export async function runJob(job: JobName) {
  switch (job) {
    case 'setup':
      return runLogged('setup', async () => {
        const season = currentSeason();
        const teams = await syncTeams(season);
        const cal = await syncCalendar(season);
        const games = await syncGames(season);
        return { season, ...teams, ...cal, ...games };
      });
    case 'cfbd':
      return runLogged('cfbd', async () => {
        const { season, week } = await ctx();
        const games = await syncGames(season);
        const ratings = await syncRatingsAndStats(season, week);
        const lines = await syncCfbdLines(season).catch((e) => ({ cfbdLinesError: e.message }));
        return { season, week, ...games, ratings, ...lines };
      });
    case 'scrape':
      return runLogged('scrape', async () => {
        const { season, week } = await ctx();
        return { season, week, ...(await runScrapers(season, week)) };
      });
    case 'odds':
      return runLogged('odds', async () => {
        const { season } = await ctx();
        return { season, ...(await syncOdds(season)) };
      });
    case 'model':
      return runLogged('model', async () => {
        const { season, week } = await ctx();
        const graded = await gradeAll(season);
        const ratings = await computePowerRatings(season, week);
        const preds = await buildPredictions(season, week);
        return { season, week, ...graded, ...ratings, ...preds };
      });
    case 'daily': {
      const { count } = await db().from('teams').select('id', { count: 'exact', head: true });
      const out: Record<string, unknown> = {};
      if (!count) out.setup = await runJob('setup');
      for (const j of ['cfbd', 'scrape', 'odds', 'model'] as const) out[j] = await runJob(j);
      return { ok: true, ...out };
    }
  }
}
