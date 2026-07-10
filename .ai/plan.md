# Pendulum Clock PWA

## Goal

A minimal progressive web app that shows a clock, optionally plays old-style pendulum tick/tock sounds, and can chime on a configurable interval (15 / 30 / 60 minutes or custom). No build step, no frameworks — static files only, ready for GitHub Pages.

## Stack and layout

Pure static site at the repo root (GitHub Pages serves `/` from `main`):

```
.ai/plan.md          # this plan (user-requested)
index.html           # shell + settings UI
styles.css           # clock face, pendulum, controls
app.js               # clock, audio, settings, chimes
sw.js                # service worker (offline cache)
manifest.webmanifest # PWA install metadata
icons/               # simple SVG/PNG icons (192, 512)
README.md            # run locally + GitHub Pages steps
```

No npm, bundler, or TypeScript.

## Features (concrete)

### Clock display
- Analog clock (hour / minute / second hands) driven by `requestAnimationFrame` or a 1s `setInterval` from `Date`.
- Subtle pendulum swing animation under the face (visual only; syncs with tick when sound is on).
- Clean, readable face; light theme; minimal chrome (brand name “Pendulum” as the page title / small header).

### Sounds (Web Audio API — no audio asset files)
Synthesize in JS so the app stays tiny and works offline without binary assets:

1. **Tick / tock** — short click-like oscillators alternating left/right feel every second when enabled.
2. **Bell / chime** — short decaying tone(s) when the clock hits a chime boundary.

User controls (persisted in `localStorage`):

| Setting | Behavior |
|--------|----------|
| Sounds on/off | Master mute: disables tick and bells |
| Tick sound | Toggle pendulum tick/tock independently (only when master is on) |
| Chime interval | Select: Off, 15 min, 30 min, 60 min, or custom minutes (number input, min 1) |
| Chime on/off | Can disable bells while keeping ticks |

Chime logic: fire when `minutes % interval === 0` and `seconds === 0` (and once per boundary — guard with last-chimed timestamp so rAF/timer doesn’t double-fire). On the hour, optionally play a slightly fuller chime (same synth, more strikes or longer decay) — keep it simple: one chime pattern for all intervals.

Browser autoplay: start audio context on first user gesture (settings toggle or “Enable sound” control) so Chrome/Safari allow playback.

### PWA
- [`manifest.webmanifest`](manifest.webmanifest): `name`, `short_name`, `start_url: "./"`, `display: "standalone"`, `background_color` / `theme_color`, icons.
- [`sw.js`](sw.js): cache-first for app shell (`index.html`, CSS, JS, manifest, icons); bump cache name on updates.
- Register SW from `app.js` only on `https:` or `localhost`.
- Add standard meta tags in `index.html` (`theme-color`, `apple-mobile-web-app-capable`, viewport).

### GitHub Pages
- Serve from root of `main` (no `/docs` or subpath unless the repo is a project site under `username.github.io/pendulum/` — use relative URLs `./` everywhere so both user and project Pages work).
- README: enable Pages → Deploy from branch `main` / `/ (root)`; open `https://<user>.github.io/pendulum/`.

## UI sketch

```
┌─────────────────────────┐
│       Pendulum          │
│      [ analog face ]    │
│      [  pendulum  ]     │
│                         │
│  ☐ Sounds               │
│  ☐ Tick                 │
│  Chime: [15▼] [custom]  │
└─────────────────────────┘
```

Settings panel below or as a small collapsible footer so the clock stays the focus.

## Implementation order

1. Write [`.ai/plan.md`](.ai/plan.md) with this plan content.
2. `index.html` + `styles.css` — analog clock + pendulum + settings markup.
3. `app.js` — time sync, hand angles, settings load/save, chime schedule, Web Audio tick + bell.
4. PWA: `manifest.webmanifest`, icons, `sw.js`, SW registration.
5. `README.md` — local open / simple static server + Pages deploy.

## Out of scope

- Backend, accounts, multiple timezones, alarms as calendar events, npm toolchain, frameworks.
