# CFB Model

A private college football betting model. It pulls advanced stats and computer ratings, blends them into one power rating, turns that into a projected spread, and compares it to DraftKings.

**Stack:** Next.js 15 (deployed on Vercel), Supabase Postgres, Vercel Cron.
**Data:** CollegeFootballData.com (CFBD), The Odds API (DraftKings lines), and scraped Sagarin and FEI ratings. You can also paste ratings from any site.

---

## How the model works

1. **Collect.** Every source's rating for every team is saved weekly in `source_ratings`, so backtests never use future information.
   - **From CFBD:** SP+, FPI, SRS, Elo, opponent-adjusted EPA, and advanced stats (success rate, explosiveness, havoc, and more).
   - **Scraped:** Sagarin Predictor and FEI.
   - **In-house MOV rating:** ridge regression on capped game margins, pulled toward the external composite. This keeps early-season numbers stable.
   - **In-house EPA (`tcc_epa`):** built from CFBD play-by-play the way cfbscrapR/cfbfastR do it. Scrimmage plays only, garbage time removed, then EPA/play, success rate and explosiveness are opponent-adjusted. Also feeds offense/defense for totals.
2. **Normalize.** Each source is centered on the average FBS team and multiplied by its `scale`. Everything ends up in points: "X points better than an average FBS team on a neutral field."
3. **Blend.** The power rating is a weighted mean of whichever sources a team has. You set the weights on the Admin page, or fit them with **Calibrate**.
4. **Project.** Home margin = home rating − away rating + HFA (no HFA at neutral sites). The model's home spread is the negative of that margin.
5. **Compare to DraftKings.**
   - Edge = model margin + DK home spread. Example: the model has the home team by 10 and DK lists them at −7, so there are +3 points of edge on the home team.
   - Cover probability = Φ(edge / σ).
   - EV uses the actual DK price.
   - A game is flagged as a **PLAY** when edge ≥ your threshold.
6. **Totals.** Every team also gets an offense and defense rating in points, blended from SP+ offense/defense, opponent-adjusted EPA, and an in-house regression on points scored and allowed.
   - Projected points = league average + your offense rating + their defense rating (points allowed above average) ± half the home-field edge.
   - Pace: each team's plays per game (both sides) sets a matchup multiplier. Two fast teams push the projection up, two slow teams pull it down. Set **Pace weight** on Admin (0 = off).
   - The projected total is compared to the DraftKings total. P(over) = Φ((model total − DK total) / σ_total), and a game is flagged when the edge ≥ the totals threshold.
7. **Lock and grade.** Predictions freeze at kickoff. They are graded ATS when the game goes final. Bets you log are graded the same way.

The **Performance** page shows ATS record by edge bucket. It also shows the model's error against final margins next to the line's error. If the model's error isn't close to the line's, trust the plays less.

---

## Setup (about 20 minutes)

### 1. Get API keys (free)
- CFBD: https://collegefootballdata.com/key. The free tier is about 1,000 calls a month, and the daily job uses about 15.
- The Odds API: https://the-odds-api.com. The free tier is 500 credits a month, and each odds pull costs 1.

### 2. Create the Supabase project
1. Go to https://supabase.com and create a **New project**. Save the database password.
2. Open **SQL Editor**, paste in all of `supabase/migrations/0001_schema.sql`, and click **Run**.
3. Also run `supabase/migrations/0002_totals.sql` the same way (adds totals), then `0003_pace.sql` (adds pace).
4. Under **Project Settings → API**, copy the **Project URL** and the **service_role** key. Keep the service_role key secret: it bypasses row-level security.

Every table has RLS turned on with no public policies. The browser never talks to Supabase directly; all reads happen on the server.

### 3. Run it locally
```bash
cp .env.example .env.local     # fill in the values
npm install
npm run dev                    # http://localhost:3000
```
Sign in with `SITE_PASSWORD`. Then go to **Admin**, click **Setup** (teams, schedule), and then click **Daily** (stats, scrapes, odds, model).

### 4. Deploy to Vercel
1. Push this folder to a private GitHub repo.
2. In Vercel, click **Add New → Project**, import the repo, and add every variable from `.env.example`.
3. Deploy. `vercel.json` sets up these daily jobs (times in UTC):
   - `11:00`: `daily` (everything)
   - `17:00`: `odds` (refresh DraftKings spreads and totals, 2 Odds API credits)
   - `17:15`: `model` (rebuild predictions)

   On the Pro plan you can add more `odds` runs, for example every 2 hours on Saturdays. Each run costs 1 Odds API credit.

If the deploy complains about `maxDuration`, lower it to 60 in `app/api/cron/[job]/route.ts` and `app/admin/page.tsx`.

You can also start any job by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://your-site.vercel.app/api/cron/odds`

---

## Pages
| Page | What it shows |
|---|---|
| **Slate** | Every game this week: ratings, model spread, DK spread and price, edge, pick, cover %, EV, and results |
| **Power Rankings** | FBS ranks with week-over-week movement and every source's rating side by side, filterable by conference |
| **Team** | Schedule with the model's numbers, rating history by week, and offense/defense advanced stats |
| **Game** | Source-by-source breakdown, line movement across books, and a bet logging form |
| **Performance** | ATS by edge bucket and by week, units, and model vs. line accuracy |
| **Bets** | Your logged bets, auto-graded, with record, units, and ROI |
| **Admin** | Run jobs, job log, model settings, source weights and scales, team-name fixes, and CSV import |
| **Blend lab** | Tests every source and blend against actual margins and points scored, next to the DK line, and can save a better blend |

## Ongoing care
- **Unmatched team names.** Different sites spell teams differently. Any name that couldn't be matched shows up on Admin; map it once and it's remembered. Common variants are pre-seeded in `lib/names.ts`.
- **Scrapers break when a site's layout changes.** The job log will say "parsed 0 rows". To fix it or add a site, edit `lib/scrapers/index.ts` and add a matching row to `rating_sources`. For sites that load their data with JavaScript (such as Massey), copy the table and paste it into **Import ratings** on Admin.
- **Blend lab** (Admin → Open Blend lab) once about 60 or more FBS games have stored pregame ratings. See below.
- **Early season** leans on preseason SP+/FPI, which include returning production and recruiting. Use a higher play threshold in weeks 1–3.

## Tests
```bash
npm test        # model math, ATS grading, rating regression, weight fitting, parsers
```

## Files
```
supabase/migrations/0001_schema.sql   tables, views, RLS, seed config
lib/cfbd.ts                           CFBD client: teams, calendar, games, ratings, stats, lines
lib/odds.ts                           The Odds API (DraftKings) to games matching
lib/pbp.ts                            play-by-play sync and in-house EPA ratings (tcc_epa)
lib/scrapers/                         Sagarin, FEI, generic table and CSV parsers
lib/names.ts                          team-name normalization and alias resolution
lib/model/math.ts                     pure math (cover prob, EV, MOV ridge, weight fit)
lib/model/compute.ts                  power ratings, predictions, grading, calibration
lib/pipeline.ts                       job orchestration (setup/cfbd/scrape/odds/model/daily)
app/                                  Next.js pages and server actions
```

*For research and entertainment. Bet responsibly.*

---

## College basketball

Use the **Football / Basketball** switch in the header. Basketball has its own Slate (by date), Power Rankings, Performance, Bets and Admin pages, stored in separate `cbb_*` tables.

- **Setup:** run `supabase/migrations/0004_basketball.sql` once, then open Basketball → Admin and click **Setup**, then **Daily**. Basketball uses the same CollegeFootballData key (shared quota), or a separate key in `CBBD_API_KEY`.
- **Ratings (tempo-free):** adjusted offense and defense in points per 100 possessions, plus tempo in possessions per game. The model blends:
  - an in-house opponent-adjusted efficiency model fit to this season's box scores (non-D1 opponents are pooled into one team)
  - CollegeBasketballData's adjusted efficiency
  - Bart Torvik's T-Rank (scraped CSV)
  - optional pasted ratings, such as KenPom
- **Preseason starting point:** last season's final ratings, regressed 40% toward average.
- **Projection:** possessions = tempoA × tempoB / league tempo. Points = possessions × (league efficiency + offense + opponent's defense) / 100, ± half the home-court edge.
- **Schedule (UTC):**
  - `15:00` `cbb_daily`: games, ratings, lines, model
  - `21:00` `cbb_lines`: DraftKings lines refresh and predictions rebuild before evening tips
- **Predictions:** made for today and the next two days, and lock at tip-off.

---

## Manual team adjustments

Run `supabase/migrations/0005_adjustments.sql` once. On **Admin** (football) or **Basketball → Admin**, under **Manual team adjustments**:
- Pick a team and enter the points, such as -7 for a starting QB out, with an optional note and date range.
- The spread moves by the full amount. About 70% comes off that team's projected points and 30% is added to the opponent's, so totals move too.
- Predictions re-run immediately, and adjusted games show an **ADJ** badge on the Slate.
- Games that have already started keep their locked numbers.

---

## Blend lab

Run `supabase/migrations/0006_blend.sql` once. Then open **Admin → Open Blend lab** and click **Run blend test**.

It rebuilds each past week's ratings exactly as they stood before kickoff, then checks them against what happened:
- **Spreads:** actual final margin vs. your current blend, equal weights, a fitted blend, each source on its own, and the DraftKings line.
- **Totals:** actual points each team scored vs. the offense/defense sources and DK's implied team total.

What the columns mean:
- **Slope:** regression of the actual result on a source's prediction. 1.0 means its point gaps are the right size; below 1 means they're too big, which inflates edges.
- **Beyond-line score:** when a method disagreed with DK, the share of that disagreement that showed up in the result. Near 0 means the edges were noise.
- **Fitted blend (held out):** each week is predicted by a fit that never saw that week. Weights are pulled toward equal weights so a small sample can't swing them wildly.

**Apply spread blend** saves the source weights, HFA, σ, and a spread slope. **Apply totals blend** saves separate totals weights (the new Totals weight column on Admin) and a points slope. Both rebuild this week's predictions. **Reset to original weights** undoes them.

---

## In-house play-by-play ratings (cfbscrapR-style)

Run `supabase/migrations/0007_pbp.sql` once. Then click **Pbp** on Admin (or just let **Daily** run it).

- **Data:** CFBD play-by-play, one API call per week. EPA per play is CFBD's `ppa`.
- **Filtering:** scrimmage snaps only (no kicks, punts, penalties, kneels or timeouts). Garbage time is dropped: lead over 38 in Q2, over 28 in Q3, over 22 in Q4.
- **Per team per game:** plays, EPA, success rate (50% of yards needed on 1st down, 70% on 2nd, 100% on 3rd/4th), explosiveness (EPA on successful plays), and rush/pass EPA. Stored in `team_game_pbp`.
- **Opponent adjustment:** a weighted ridge regression, value ≈ average + home edge + offense + opponent defense. FCS opponents are pooled into one team, and shrinkage is about 2 games' worth of plays.
- **Snapshots:** a rating is saved for every week using only earlier games. History goes back to week 2, so the Blend lab can test it fairly.
- **The first run** backfills 4 weeks at a time. Click **Pbp** a couple of times, or let Daily catch up over a few days.
- **Rating:** net adjusted EPA/play × 60 ≈ points. Its offense and defense also blend into totals. Check its slope in the Blend lab before giving it more weight.
- **The Team page** shows the adjusted offense and defense numbers with FBS ranks.
