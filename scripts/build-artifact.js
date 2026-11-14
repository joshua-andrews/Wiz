'use strict';
/*
  Builds the Claude artifact version of the Bets of the Day board: bets.html with today's
  DraftKings numbers baked in, so it works without the server.

    node scripts/build-artifact.js <out.html> [previous-artifact.html]

  Pass the previously published page to keep "Biggest moves" counting from the first
  snapshot of the day instead of starting over.
*/
const fs = require('node:fs');
const path = require('node:path');
const bets = require('../bets.js');

const [out, previous] = process.argv.slice(2);
if (!out) { console.error('Usage: node scripts/build-artifact.js <out.html> [previous-artifact.html]'); process.exit(1); }

const readEmbedded = html => {
  const m = /<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
};

(async () => {
  const board = JSON.parse(JSON.stringify(await bets.getBoard()));

  // Carry the day's first-seen numbers forward from the last published snapshot.
  const prev = previous && fs.existsSync(previous) ? readEmbedded(fs.readFileSync(previous, 'utf8')) : null;
  if (prev && prev.day === board.day) {
    const first = new Map();
    for (const g of prev.games) for (const m of g.markets) m.sides.forEach((s, i) =>
      first.set(`${g.id}|${m.type}|${i}`, { bets: s.firstBets, handle: s.firstHandle, at: s.firstAt }));
    for (const g of board.games) for (const m of g.markets) m.sides.forEach((s, i) => {
      const f = first.get(`${g.id}|${m.type}|${i}`);
      if (f && f.at) { s.firstBets = f.bets; s.firstHandle = f.handle; s.firstAt = f.at; }
    });
    if (prev.trackingSince && prev.trackingSince < board.trackingSince) board.trackingSince = prev.trackingSince;
  }

  let html = fs.readFileSync(path.join(__dirname, '..', 'bets.html'), 'utf8')
    .replace(/^<!doctype html>\s*/i, '')
    .replace(/<!-- server-only:start -->[\s\S]*?<!-- server-only:end -->\s*/g, '')
    .replace('<!--account-->', '');
  const json = JSON.stringify(board).replace(/</g, '\\u003c');
  html = html.replace('<!--board-data-->', `<script type="application/json" id="board-data">${json}</script>`);
  fs.writeFileSync(out, html);
  console.log(`Wrote ${out}: ${board.games.length} games, ${(html.length / 1024).toFixed(0)} KB, numbers from ${board.sourceUpdatedAt || board.fetchedAt}`);
})().catch(err => { console.error(err); process.exit(1); });
