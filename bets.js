'use strict';
/*
  Bets of the Day: pulls today's betting splits (% of bets and % of money on each side)
  from DraftKings Network's public "Betting Splits" page, and remembers the first numbers
  it saw each day so the board can show how the public has moved since.

  No dependencies. The page is fetched at most once every 10 minutes, and only while
  someone is looking at the board.

  If DraftKings changes how that page is built, the parser below is the part to fix.
*/

const SOURCE = 'https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/';
const FRESH_MS = 10 * 60e3;     // reuse a download for this long
const FORCE_MIN_MS = 2 * 60e3;  // "Refresh" can't fetch more often than this
const MAX_PAGES = 15;           // per league; DraftKings shows 10 games a page
const PER_PAGE = 10;
const PARALLEL = 3;             // leagues fetched at the same time
const TIMEOUT_MS = 15e3;

// Used only if the league menu can't be read from the page.
const FALLBACK_LEAGUES = [
  ['88808', 'NFL'], ['42648', 'NBA'], ['42133', 'NHL'], ['84240', 'MLB'], ['94682', 'WNBA'],
  ['9034', 'UFC'], ['87637', 'NCAA Football'], ['92483', 'NCAA Basketball'],
  ['36647', 'NCAA Womens Basketball'], ['40253', 'England Premier League'],
  ['40685', 'Champions League'], ['41410', 'Europa League'], ['89345', 'MLS'],
].map(([id, name]) => ({ id, name }));

// Shorter names for the chips.
const SHORT = {
  'NCAA Football': 'NCAAF', 'NCAA Basketball': 'NCAAB', 'NCAA Womens Basketball': 'NCAAW',
  'NCAA Baseball': 'NCAA Baseball', 'NCAA Ice Hockey': 'NCAA Hockey',
  'England Premier League': 'Premier League', 'Champions League': 'Champions League',
};

// ---- Dates (DraftKings lists times in US Eastern) -------------------------------
const ET = 'America/New_York';
const etParts = ms => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms);
  const g = t => Number(p.find(x => x.type === t).value);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute') };
};
const etDay = (ms = Date.now()) => { const p = etParts(ms); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
function etToDate(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = etParts(guess);
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess;
  return new Date(guess - offset);
}
// "Sun 11/15 · 9:30 AM ET" -> ISO time
function parseStart(text) {
  const m = /(\d{1,2})\/(\d{1,2})\s*·\s*(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(text || '');
  if (!m) return null;
  const now = etParts(Date.now());
  const mo = Number(m[1]), d = Number(m[2]);
  let y = now.y;
  if (now.mo === 12 && mo === 1) y++;          // a January game seen in December
  else if (now.mo === 1 && mo === 12) y--;
  let h = Number(m[3]) % 12;
  if (m[5].toUpperCase() === 'PM') h += 12;
  return etToDate(y, mo, d, h, Number(m[4])).toISOString();
}

// ---- Reading the page -------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#038': '&', '#039': "'", rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—' };
const decode = s => String(s).replace(/&(#?\w+);/g, (all, k) => {
  if (ENTITIES[k] !== undefined) return ENTITIES[k];
  if (/^#\d+$/.test(k)) return String.fromCodePoint(Number(k.slice(1)));
  if (/^#x[0-9a-f]+$/i.test(k)) return String.fromCodePoint(parseInt(k.slice(2), 16));
  return all;
});
const text = s => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseLeagues(html) {
  const select = /<select[^>]*name="tb_eg"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (!select) return null;
  const out = [];
  for (const m of select[1].matchAll(/<option\s+value="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)) {
    if (m[1] !== '0') out.push({ id: m[1], name: text(m[2]) });
  }
  return out.length ? out : null;
}

function parseGames(html, league) {
  const games = [];
  // Each game is a <div class="tb-se ..."> block; split on it.
  for (const block of html.split(/class="tb-se\s/).slice(1)) {
    const h5 = /<h5[^>]*>([\s\S]*?)<\/h5>/.exec(block);
    if (!h5) continue;
    const title = text(h5[1]);
    const id = (/sportsbook\.draftkings\.com\/event\/(\d+)/.exec(block) || [])[1] || title;
    const when = (/([A-Z][a-z]{2} \d{1,2}\/\d{1,2}\s*·\s*\d{1,2}:\d{2}\s*[AP]M(?:\s*ET)?)/.exec(block) || [])[1] || '';
    const [away, home] = title.split(/\s+(?:@|vs\.?)\s+/);

    // Markets: an orange label ("Moneyline", "Spread", "Total"...) followed by its rows.
    const labels = [...block.matchAll(/text-brand-orange[^>]*>\s*([^<]+?)\s*<\/div>/g)];
    const markets = [];
    labels.forEach((lab, i) => {
      const section = block.slice(lab.index, i + 1 < labels.length ? labels[i + 1].index : undefined);
      const sides = [];
      for (const row of section.split(/class="tb-sodd\s/).slice(1)) {
        const name = text((/tb-slipline[^>]*>([\s\S]*?)<\/div>/.exec(row) || [])[1]);
        const oddsText = text((/tb-odd-s[^>]*>([\s\S]*?)<\/a>/.exec(row) || [])[1]).replace(/−/g, '-');
        const pct = [...row.matchAll(/<div>\s*(\d{1,3})%/g)].map(m => Number(m[1]));
        if (!name || pct.length < 2) continue;
        sides.push({ name, odds: oddsText || null, handle: pct[0], bets: pct[1] });
      }
      if (sides.length >= 2) markets.push({ type: text(lab[1]), sides });
    });
    if (!markets.length) continue;

    games.push({
      id: String(id),
      league: league.name,
      leagueShort: SHORT[league.name] || league.name,
      title, away: away || title, home: home || '',
      when: when.replace(/\s*ET$/, '').replace(/\s+/g, ' '),
      start: parseStart(when),
      url: /^\d+$/.test(id) ? `https://sportsbook.draftkings.com/event/${id}` : null,
      markets,
    });
  }
  return games;
}

const sourceTime = html => (/data-generated-at="([^"]+)"/.exec(html) || [])[1] || null;

async function download(leagueId, page) {
  const url = `${SOURCE}?tb_eg=${leagueId}&tb_edate=today&tb_emt=0${page > 1 ? `&tb_page=${page}` : ''}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BetsOfTheDay/1.0)', Accept: 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DraftKings answered ${res.status}`);
  return res.text();
}

async function fetchLeague(league, first) {
  const games = [];
  const seen = new Set();
  let stamp = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = page === 1 && first ? first : await download(league.id, page);
    stamp = stamp || sourceTime(html);
    const found = parseGames(html, league);
    const fresh = found.filter(g => !seen.has(g.id));
    for (const g of fresh) { seen.add(g.id); games.push(g); }
    if (found.length < PER_PAGE || !fresh.length) break;
  }
  return { games, stamp };
}

async function inBatches(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]).then(v => ({ ok: v }), e => ({ err: e })); }
  }));
  return out;
}

// ---- Tracking: the first numbers seen today, per side ----------------------------
let trackDay = etDay();
let trackStart = null;
const firstSeen = new Map();

function track(games, at) {
  const day = etDay(at);
  if (day !== trackDay) { trackDay = day; firstSeen.clear(); trackStart = null; }
  if (!trackStart) trackStart = new Date(at).toISOString();
  for (const g of games) for (const m of g.markets) m.sides.forEach((s, i) => {
    const key = `${g.id}|${m.type}|${i}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { bets: s.bets, handle: s.handle, at: new Date(at).toISOString() });
    const f = firstSeen.get(key);
    s.firstBets = f.bets;
    s.firstHandle = f.handle;
    s.firstAt = f.at;
  });
}

// ---- The board ------------------------------------------------------------------------
let board = null;      // last good result
let refreshing = null; // the refresh in progress, if any

async function refresh() {
  const at = Date.now();
  // The first league's page also carries the league menu.
  let leagues = FALLBACK_LEAGUES;
  let firstHtml = null;
  try {
    firstHtml = await download(FALLBACK_LEAGUES[0].id, 1);
    leagues = parseLeagues(firstHtml) || FALLBACK_LEAGUES;
  } catch (err) {
    firstHtml = null;
  }
  // Last, the all-sports list catches games outside the league menu (international soccer, etc.).
  const lists = [...leagues, { id: '0', name: 'Other' }];
  const results = await inBatches(lists, PARALLEL, lg => fetchLeague(lg, lg.id === FALLBACK_LEAGUES[0].id ? firstHtml : null));

  const games = [];
  const seen = new Set();
  const errors = [];
  let stamp = null;
  results.forEach((r, i) => {
    if (r.err) { errors.push(`${lists[i].name}: ${r.err.message || r.err}`); return; }
    stamp = stamp || r.ok.stamp;
    for (const g of r.ok.games) if (!seen.has(g.id)) { seen.add(g.id); games.push(g); }
  });
  if (!games.length && errors.length === results.length) throw new Error(errors[0] || 'Could not reach DraftKings');

  track(games, at);
  const counts = new Map();
  for (const g of games) counts.set(g.league, (counts.get(g.league) || 0) + 1);
  board = {
    day: trackDay,
    fetchedAt: new Date(at).toISOString(),
    sourceUpdatedAt: stamp,
    trackingSince: trackStart,
    leagues: lists.filter(l => counts.has(l.name)).map(l => ({ name: l.name, short: SHORT[l.name] || l.name, games: counts.get(l.name) })),
    games,
    errors,
    source: SOURCE,
  };
  return board;
}

function startRefresh() {
  if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}

// Returns today's board. Waits for DraftKings only when there's nothing usable yet;
// otherwise answers right away and updates in the background.
async function getBoard({ force = false } = {}) {
  const age = board ? Date.now() - Date.parse(board.fetchedAt) : Infinity;
  const stale = !board || board.day !== etDay();
  if (stale) return startRefresh();
  if (force && age > FORCE_MIN_MS) return startRefresh();
  if (age > FRESH_MS) startRefresh().catch(err => console.error('Bets refresh failed:', err.message));
  return board;
}

module.exports = { getBoard, parseGames, parseLeagues, parseStart };
