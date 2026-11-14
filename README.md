# Basic Strategy Flashcards

A flashcard drill for blackjack basic strategy, with a login in front of it.

| File | What it is |
|---|---|
| `index.html` | The whole app: strategy chart data, flashcards, coaching tips |
| `login.html` | The sign-in page |
| `server.js` | Small Node server that checks logins (no dependencies) |
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
