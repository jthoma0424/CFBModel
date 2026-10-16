import { db, insertChunked, selectAll } from './supabase';
import { NameResolver } from './names';

/**
 * Pull current spreads for one bookmaker (default DraftKings) from The Odds API.
 * Cost: 1 credit per call (1 market x 1 bookmaker). Free tier = 500 credits/month.
 */
export async function syncOdds(season: number) {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error('ODDS_API_KEY not set');
  const book = process.env.ODDS_BOOKMAKER || 'draftkings';
  const url = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/');
  url.search = new URLSearchParams({ apiKey: key, regions: 'us', markets: 'spreads', bookmakers: book, oddsFormat: 'american' }).toString();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Odds API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const remaining = res.headers.get('x-requests-remaining');
  const events: any[] = await res.json();

  const resolver = await new NameResolver('odds_api').load();
  const games = await selectAll<any>((a, b) =>
    db().from('games').select('id,home_id,away_id,start_date,odds_event_id').eq('season', season).eq('completed', false).range(a, b),
  );
  const latest = await selectAll<any>((a, b) => db().from('latest_lines').select('game_id,home_spread,home_price,away_price').eq('book', book).range(a, b));
  const last = new Map(latest.map((l) => [l.game_id, l]));

  const rows: any[] = [];
  let matched = 0, unmatched = 0;
  for (const ev of events) {
    const homeId = resolver.resolve(ev.home_team);
    const awayId = resolver.resolve(ev.away_team);
    if (!homeId || !awayId) { unmatched++; continue; }
    const t = new Date(ev.commence_time).getTime();
    // Match on team pair within ±2 days. Odds feeds sometimes flip home/away at neutral sites.
    const g = games.find((g) =>
      Math.abs(new Date(g.start_date).getTime() - t) < 2 * 86400e3 &&
      ((g.home_id === homeId && g.away_id === awayId) || (g.home_id === awayId && g.away_id === homeId)),
    );
    if (!g) { unmatched++; continue; }
    matched++;
    if (g.odds_event_id !== ev.id) await db().from('games').update({ odds_event_id: ev.id }).eq('id', g.id);

    const bk = ev.bookmakers?.find((b: any) => b.key === book);
    const mkt = bk?.markets?.find((m: any) => m.key === 'spreads');
    if (!mkt) continue;
    // Outcomes are named by the feed's team names; map them back to our home/away.
    const homeName = g.home_id === homeId ? ev.home_team : ev.away_team;
    const homeOut = mkt.outcomes.find((o: any) => o.name === homeName);
    const awayOut = mkt.outcomes.find((o: any) => o.name !== homeName);
    if (!homeOut || !awayOut) continue;
    const prev = last.get(g.id);
    if (prev && Number(prev.home_spread) === homeOut.point && prev.home_price === homeOut.price && prev.away_price === awayOut.price) continue;
    rows.push({
      game_id: g.id, odds_event_id: ev.id, book,
      home_spread: homeOut.point, home_price: homeOut.price,
      away_spread: awayOut.point, away_price: awayOut.price,
    });
  }
  if (rows.length) await insertChunked('odds_lines', rows);
  await resolver.flushMisses();
  return { events: events.length, matched, unmatched, newLines: rows.length, creditsRemaining: remaining };
}
