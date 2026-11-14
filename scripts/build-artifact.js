'use strict';
/*
  Builds the Claude artifact version of Bets of the Day, and keeps its track record.

    node scripts/build-artifact.js <out.html> [previous-artifact.html]

  Each run:
    1. Downloads today's DraftKings splits (the "Today" tab).
    2. Saves the latest splits for every game that hasn't started yet. The last save
       before kickoff is the closing number that gets graded.
    3. Grades saved games that have finished, using ESPN final scores.
    4. Writes one self-contained page with everything embedded.

  The artifact is its own database: pass the previously published page as the second
  argument and its saved bets and track record carry forward. Without it, tracking
  starts over.
*/
const fs = require('node:fs');
const path = require('node:path');
const bets = require('../bets.js');
const { grade, kindOf } = require('../grade.js');

const GRADE_AFTER_MS = 2.5 * 3600e3;  // look for a final score this long after kickoff
const GIVE_UP_MS = 3 * 864e5;         // stop trying after 3 days

const [out, previous] = process.argv.slice(2);
if (!out) { console.error('Usage: node scripts/build-artifact.js <out.html> [previous-artifact.html]'); process.exit(1); }

const readEmbedded = html => {
  const m = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  const j = JSON.parse(m[1]);
  return j.v ? j : { v: 1, board: j };   // the first version embedded the board alone
};
const etDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

(async () => {
  const now = Date.now();
  const prev = previous && fs.existsSync(previous) ? readEmbedded(fs.readFileSync(previous, 'utf8')) : null;
  if (previous && !prev) throw new Error(`No saved data found in ${previous}; refusing to start the track record over`);

  const board = JSON.parse(JSON.stringify(await bets.getBoard()));
  const pending = new Map((prev && prev.pending || []).map(p => [p.id, p]));
  const history = prev && prev.history ? prev.history : [];
  const meta = Object.assign({ trackingSince: new Date(now).toISOString(), graded: 0, dropped: 0, skipped: 0, misses: [] }, prev && prev.meta);

  // 1. "Biggest moves" counts from the first snapshot of the day.
  const pb = prev && prev.board;
  if (pb && pb.day === board.day) {
    const first = new Map();
    for (const g of pb.games) for (const m of g.markets) m.sides.forEach((s, i) =>
      first.set(`${g.id}|${m.type}|${i}`, { bets: s.firstBets, handle: s.firstHandle, at: s.firstAt }));
    for (const g of board.games) for (const m of g.markets) m.sides.forEach((s, i) => {
      const f = first.get(`${g.id}|${m.type}|${i}`);
      if (f && f.at) { s.firstBets = f.bets; s.firstHandle = f.handle; s.firstAt = f.at; }
    });
    if (pb.trackingSince && pb.trackingSince < board.trackingSince) board.trackingSince = pb.trackingSince;
  }

  // 2. Save the latest pre-game splits.
  let saved = 0;
  for (const g of board.games) {
    if (!g.start || Date.parse(g.start) <= now) continue;
    for (const m of g.markets) {
      if (!kindOf(m.type)) continue;
      pending.set(`${g.id}|${m.type}`, {
        id: `${g.id}|${m.type}`, league: g.league, leagueShort: g.leagueShort, title: g.title,
        away: g.away, home: g.home, start: g.start, type: m.type,
        sides: m.sides.map(s => ({ name: s.name, odds: s.odds, bets: s.bets, handle: s.handle })),
        at: new Date(now).toISOString(),
      });
      saved++;
    }
  }

  // 3. Grade what has finished.
  let graded = 0, waiting = 0, dropped = 0, skipped = 0;
  const done = new Set(history.map(h => h.id));
  for (const p of [...pending.values()]) {
    const started = Date.parse(p.start);
    if (now - started < GRADE_AFTER_MS) continue;
    if (done.has(p.id)) { pending.delete(p.id); continue; }
    let r;
    try { r = await grade(p); } catch (err) { r = { done: false, why: err.message }; }
    if (r.done && r.result) {
      history.push({
        id: p.id, d: etDay(started), st: p.start, L: p.league, l: p.leagueShort, t: p.type, k: kindOf(p.type),
        g: p.title, sc: r.result.score, cap: p.at,
        s: p.sides.map((s, i) => [s.name, s.odds, s.bets, s.handle, r.result.r[i]]),
      });
      pending.delete(p.id); graded++;
    } else if (r.done) {
      pending.delete(p.id); skipped++;
    } else if (now - started > GIVE_UP_MS) {
      pending.delete(p.id); dropped++;
      meta.misses = [`${p.leagueShort}: ${p.title} (${r.why})`, ...meta.misses.filter(x => !x.includes(p.title))].slice(0, 20);
    } else {
      waiting++;
    }
  }
  meta.graded += graded; meta.dropped += dropped; meta.skipped += skipped;
  meta.updatedAt = new Date(now).toISOString();
  history.sort((a, b) => (a.st < b.st ? -1 : a.st > b.st ? 1 : 0));

  // 4. Write the page.
  const blob = { v: 2, board, pending: [...pending.values()], history, meta };
  let html = fs.readFileSync(path.join(__dirname, '..', 'bets.html'), 'utf8')
    .replace(/^<!doctype html>\s*/i, '')
    .replace(/<!-- server-only:start -->[\s\S]*?<!-- server-only:end -->\s*/g, '')
    .replace('<!--account-->', '');
  const json = JSON.stringify(blob).replace(/</g, '\\u003c');
  html = html.replace('<!--board-data-->', `<script type="application/json" id="board-data">${json}</script>`);
  fs.writeFileSync(out, html);

  console.log([
    `Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`,
    `Today: ${board.games.length} games, numbers from ${board.sourceUpdatedAt || board.fetchedAt}`,
    `Saved pre-game splits for ${saved} bets; ${blob.pending.length} waiting for results`,
    `Graded ${graded} this run (${history.length} total); ${waiting} not final yet; ${skipped} skipped; ${dropped} gave up`,
    board.errors.length ? `DraftKings errors: ${board.errors.join('; ')}` : '',
  ].filter(Boolean).join('\n'));
})().catch(err => { console.error(err.stack || err); process.exit(1); });
