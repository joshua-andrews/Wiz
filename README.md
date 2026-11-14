# Basic Strategy Flashcards + Bets of the Day

Two tools behind one login:

- **Blackjack** (`/`): a flashcard drill for basic strategy.
- **Bets of the Day** (`/bets`): today's most popular bets at DraftKings, ranked by % of bets, % of money, the gap between them, or how much they've moved today.

| File | What it is |
|---|---|
| `index.html` | The blackjack app: strategy chart data, flashcards, coaching tips |
| `bets.html` | The bets board: filters, rankings, the at-a-glance tiles |
| `bets.js` | Downloads and reads DraftKings' public betting splits page, and tracks movement through the day |
| `grade.js` | Grades saved bets (win, loss or push) against ESPN final scores |
| `scripts/build-artifact.js` | Builds the Claude artifact version, saves pre-game splits and grades finished games |
| `login.html` | The sign-in page |
| `server.js` | Small Node server that checks logins and serves both apps (no dependencies) |
| `manifest.webmanifest`, `icons/` | Lets phones add the app to the home screen |

## Logins

Logins live in the `USERS` variable on Railway (service, then Variables):

```
USERS=player:first-password,sam:another-password
```

- Add a person: add `,name:password` to the end.
- Remove a person: delete their `name:password`. They're signed out right away.
- Passwords can't contain commas.

`SESSION_SECRET` signs the login cookies. Changing it signs everyone out.

## Run it on your computer

```
USERS="player:test" node server.js
```

Then open http://localhost:3000.

## Bets of the Day: how it works

| Step | What happens |
|---|---|
| 1 | You open `/bets`. The server downloads today's splits for every league on [DraftKings Network's betting splits page](https://dknetwork.draftkings.com/draftkings-sportsbook-betting-splits/) (about 2 to 5 seconds). |
| 2 | It keeps that copy for 10 minutes. While the page is open it checks back every 3 minutes; **Refresh** forces a new download (at most once every 2 minutes). |
| 3 | The first numbers it sees each day are remembered, so **Biggest moves** can show how far each side has moved since. This memory resets at midnight Eastern and whenever the server restarts or redeploys. |

Things to know:

- Nothing is downloaded unless someone has the board open.
- DraftKings doesn't publish how many bets were placed, so a lopsided split on a small game may be only a few tickets. 100/0 splits are hidden unless you tick the box.
- Moneylines are off by default because heavy favourites take 95%+ of tickets almost every game.
- It reads a public web page, not an official API. If DraftKings redesigns that page, the board will show an error until `parseGames` in `bets.js` is updated.

## The Claude artifact and the track record

The board also runs as a Claude artifact, with a **Track record** tab that answers: does the side with more money win more often than its odds say?

| Step | What happens |
|---|---|
| 1 | A scheduled Claude task runs at 11:13 AM, 3:13 PM, 6:13 PM and 10:13 PM Eastern. |
| 2 | It reads the published artifact (the artifact holds all saved data) and runs `node scripts/build-artifact.js <out.html> <current-artifact.html>`. |
| 3 | The script saves the latest splits for every game that hasn't started, grades finished games against ESPN final scores, and writes a new page. |
| 4 | The task republishes the page to the same artifact link. |

Things to know:

- The graded number is the last save before kickoff, so it can be up to about 4 hours before the game.
- Games that can't be found on ESPN after 3 days are dropped and counted. International soccer from the "Other" list isn't graded.
- The artifact grows by roughly 80 KB a day. It stays under the 16 MB page limit for several months; trim old history before then.
