'use strict';
/*
  Grades saved bets against final scores from ESPN's public scoreboard.

  A saved bet is one market of one game (moneyline, spread or total) with the splits and
  odds captured before kickoff. Grading finds the same game on ESPN, checks it's final, and
  marks each side W (won), L (lost), P (push) or V (void: postponed or cancelled).
*/

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/';
const TIMEOUT_MS = 15e3;

// DraftKings league name -> ESPN scoreboard path(s)
const LEAGUES = {
  'NFL': ['football/nfl'],
  'NBA': ['basketball/nba'],
  'NHL': ['hockey/nhl'],
  'MLB': ['baseball/mlb'],
  'WNBA': ['basketball/wnba'],
  'UFL': ['football/ufl'],
  'UFC': ['mma/ufc'],
  'NCAA Football': ['football/college-football?groups=80', 'football/college-football?groups=81'],
  'NCAA Basketball': ['basketball/mens-college-basketball?groups=50'],
  'NCAA Womens Basketball': ['basketball/womens-college-basketball?groups=50'],
  'NCAA Ice Hockey': ['hockey/mens-college-hockey'],
  'NCAA Baseball': ['baseball/college-baseball'],
  'England Premier League': ['soccer/eng.1'],
  'Champions League': ['soccer/uefa.champions'],
  'Europa League': ['soccer/uefa.europa'],
  'MLS': ['soccer/usa.1'],
};
const canGrade = league => Boolean(LEAGUES[league]);

// What kind of bet a market is
const kindOf = type => /money ?line/i.test(type) ? 'ml'
  : /spread|puck line|run line|handicap/i.test(type) ? 'spread'
  : /total/i.test(type) ? 'total' : null;

// ---- Names ----------------------------------------------------------------------------
const words = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')  // drop accents
  .replace(/\[w\]/gi, '')                            // DraftKings tags women's teams "[W]"
  .toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);

function namesOf(c) {
  const t = c.team || {}, a = c.athlete || {};
  return [t.abbreviation, t.location, t.name, t.displayName, t.shortDisplayName, t.nickname, a.displayName, a.shortName, a.fullName]
    .filter(Boolean);
}
// Share of the DraftKings name's words found in ESPN's names for this competitor (0..1)
function nameScore(dkName, comp) {
  const dk = words(dkName);
  if (!dk.length) return 0;
  const espn = new Set(namesOf(comp).flatMap(words));
  // "St" can mean State or Saint
  const has = w => espn.has(w)
    || (w === 'state' && espn.has('st'))
    || (w === 'saint' && espn.has('st'))
    || (w === 'st' && (espn.has('state') || espn.has('saint')));
  return dk.filter(has).length / dk.length;
}

// ---- ESPN -----------------------------------------------------------------------------
const cache = new Map();
async function scoreboard(path, ymd) {
  const [base, query] = path.split('?');
  const url = `${ESPN}${base}/scoreboard?${query ? query + '&' : ''}dates=${ymd}&limit=500`;
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BetsOfTheDay/1.0)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`ESPN answered ${res.status} for ${path}`);
      const j = await res.json();
      // UFC lists each fight as a competition; everything else has one per event.
      const out = [];
      for (const e of j.events || []) for (const c of e.competitions || []) {
        if ((c.competitors || []).length !== 2) continue;
        out.push({
          date: c.date || e.date,
          status: (c.status || e.status || {}).type || {},
          comps: c.competitors.map(x => ({ ...x, scoreNum: Number(x.score && typeof x.score === 'object' ? x.score.value : x.score) })),
        });
      }
      return out;
    })());
  }
  return cache.get(url);
}

const etYmd = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(ms).replace(/-/g, '');

// Find the ESPN game for a saved bet: same league, kickoff within 4 hours, both names match.
async function findGame(bet) {
  const paths = LEAGUES[bet.league];
  if (!paths) return null;
  const start = Date.parse(bet.start);
  const days = [...new Set([etYmd(start), etYmd(start - 864e5)])];
  let best = null;
  for (const path of paths) for (const ymd of days) {
    let games;
    try { games = await scoreboard(path, ymd); } catch { continue; }
    for (const g of games) {
      if (Math.abs(Date.parse(g.date) - start) > 4 * 3600e3) continue;
      const [c1, c2] = g.comps;
      const straight = [nameScore(bet.away, c1), nameScore(bet.home, c2)];
      const swapped = [nameScore(bet.away, c2), nameScore(bet.home, c1)];
      for (const [pair, away, home] of [[straight, c1, c2], [swapped, c2, c1]]) {
        if (Math.min(...pair) < 0.5) continue;
        const score = pair[0] + pair[1];
        if (!best || score > best.score) best = { score, game: g, away, home };
      }
    }
  }
  return best;
}

// ---- Grading ----------------------------------------------------------------------------
const lineOf = name => { const m = /\s([+-]?\d+(?:\.\d+)?)\s*$/.exec(String(name).replace(/−/g, '-')); return m ? Number(m[1]) : null; };
const teamOf = name => String(name).replace(/−/g, '-').replace(/\s[+-]?\d+(?:\.\d+)?\s*$/, '').trim();
const cmp = (a, b) => (a > b ? 'W' : a < b ? 'L' : 'P');

// Which team (away/home) a side is on, by its name
function whichTeam(sideName, bet) {
  const t = teamOf(sideName).toLowerCase();
  if (t === String(bet.away).toLowerCase()) return 'away';
  if (t === String(bet.home).toLowerCase()) return 'home';
  const a = words(t).filter(w => words(bet.away).includes(w)).length;
  const h = words(t).filter(w => words(bet.home).includes(w)).length;
  return a > h ? 'away' : h > a ? 'home' : null;
}

function gradeSides(bet, awayScore, homeScore) {
  const kind = kindOf(bet.type);
  return bet.sides.map(s => {
    if (kind === 'total') {
      const m = /^(over|under)\s+([\d.]+)/i.exec(s.name);
      if (!m) return null;
      const r = cmp(awayScore + homeScore, Number(m[2]));
      return /^over/i.test(m[1]) ? r : r === 'W' ? 'L' : r === 'L' ? 'W' : 'P';
    }
    if (kind === 'ml' && /^(draw|tie)$/i.test(s.name.trim())) return awayScore === homeScore ? 'W' : 'L';
    const team = whichTeam(s.name, bet);
    if (!team) return null;
    const mine = team === 'away' ? awayScore : homeScore;
    const theirs = team === 'away' ? homeScore : awayScore;
    if (kind === 'ml') return cmp(mine, theirs);
    if (kind === 'spread') { const line = lineOf(s.name); return line === null ? null : cmp(mine + line, theirs); }
    return null;
  });
}

/*
  Grades one saved bet. Returns:
    { done: true, result }   graded (result has per-side W/L/P/V and the final score)
    { done: false, why }     not final yet, or not found yet; try again later
*/
async function grade(bet) {
  if (!kindOf(bet.type)) return { done: true, skip: 'bet type not graded' };
  if (!canGrade(bet.league)) return { done: true, skip: `no scores source for ${bet.league}` };
  const hit = await findGame(bet);
  if (!hit) return { done: false, why: 'not found on ESPN' };
  const st = hit.game.status;
  if (/postpon|cancel|forfeit|suspend/i.test(st.name || '') || /postpon|cancel/i.test(st.description || '')) {
    return { done: true, result: { r: bet.sides.map(() => 'V'), score: st.description || 'Void' } };
  }
  if (!st.completed) return { done: false, why: st.description || 'not final' };
  const a = hit.away.scoreNum, h = hit.home.scoreNum;
  if (!Number.isFinite(a) || !Number.isFinite(h)) return { done: false, why: 'no score' };
  const r = gradeSides(bet, a, h);
  if (r.some(x => x === null)) return { done: true, skip: 'could not read the bet' };
  return { done: true, result: { r, score: `${bet.away} ${a}, ${bet.home} ${h}` } };
}

module.exports = { grade, gradeSides, findGame, kindOf, canGrade, nameScore, LEAGUES };
