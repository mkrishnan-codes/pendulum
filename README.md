# Pendulum

A lightweight analog clock progressive web app with optional pendulum tick sounds and configurable interval chimes. Pure HTML, CSS, and JavaScript — no build tools or package managers.

## Features

- Analog clock with a swinging pendulum
- Optional tick / tock sounds (Web Audio, no audio files)
- Chimes at 15, 30, or 60 minutes (default 30)
- Quiet hours (default 9:00 PM – 6:30 AM) to mute all sounds
- Settings saved in `localStorage`
- Installable PWA with offline support

## Run locally

Because of the service worker, use a simple static server. From this directory:

```bash
npx serve .
```

Or with Python (no Node required):

```bash
python3 -m http.server 8080
```

Then open the URL printed in the terminal (typically [http://localhost:3000](http://localhost:3000) for `serve`, or [http://localhost:8080](http://localhost:8080) for Python).

You can also open `index.html` directly in a browser; sound and PWA install work best over `http://localhost` or HTTPS.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo: **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose branch `main` and folder `/ (root)`, then save.
5. After a minute or two, open:

   https://mkrishnan-codes.github.io/pendulum/

All asset URLs are relative (`./`), so project Pages under a subpath work without changes.

## Sounds

Browsers block audio until you interact with the page. Turn on **Sounds** once to unlock audio; then use **Tick** and **Chime** independently.

Leave the tab open in the background — the visual clock may pause, but ticks and chimes keep playing (audio is scheduled ahead on the Web Audio clock). Closing the tab stops them.

## Chime timing

Chimes are aligned to the clock face, not to when you turn the setting on. Default interval is **30 minutes**.

| Interval | Rings at |
|----------|----------|
| 15 min | `:00`, `:15`, `:30`, `:45` |
| 30 min | `:00`, `:30` |
| 60 min | `:00` (on the hour) |

Example: if you enable a 15-minute chime at 10:42, the next chime is **10:45**, not 10:57.

### How many strikes

| When | Strikes |
|------|---------|
| On the hour (`:00`) | 2 |
| Half / quarter (`:15`, `:30`, `:45`) | 1 |

## Quiet hours

When **Quiet hours** is on, tick and chime are muted between the configured times (default **21:00** to **06:30**, spanning midnight). Turn the option off, or change **From** / **to**, to suit your bedtime.
