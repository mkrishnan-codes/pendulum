(() => {
  "use strict";

  const STORAGE_KEY = "pendulum-settings-v2";
  const ALLOWED_INTERVALS = new Set(["15", "30", "60"]);
  const STRIKE_GAP = 1.25;
  // Warm mantel-clock gong — lower, softer partials that sit with the wooden tick.
  const BELL_PARTIALS = [
    { ratio: 1, gain: 1, decay: 2.8 },
    { ratio: 1.5, gain: 0.4, decay: 2.2 },
    { ratio: 2.0, gain: 0.28, decay: 1.8 },
    { ratio: 2.67, gain: 0.12, decay: 1.2 },
    { ratio: 3.5, gain: 0.06, decay: 0.8 },
  ];
  const BELL_FUNDAMENTAL = 392; // G4 — deeper mantel gong
  // Schedule far enough ahead that background-tab timer throttling still leaves audio queued.
  const SCHEDULE_AHEAD_MS = 45000;
  const SCHEDULER_POLL_MS = 1000;

  const defaults = {
    soundsEnabled: false,
    tickEnabled: true,
    chimeEnabled: true,
    chimeInterval: "30",
    quietEnabled: true,
    quietStart: "21:00",
    quietEnd: "06:30",
  };

  const els = {
    marks: document.getElementById("marks"),
    numerals: document.getElementById("numerals"),
    hourHand: document.getElementById("hour-hand"),
    minuteHand: document.getElementById("minute-hand"),
    secondHand: document.getElementById("second-hand"),
    pendulum: document.getElementById("pendulum"),
    timeReadout: document.getElementById("time-readout"),
    soundsEnabled: document.getElementById("sounds-enabled"),
    tickEnabled: document.getElementById("tick-enabled"),
    chimeEnabled: document.getElementById("chime-enabled"),
    chimeInterval: document.getElementById("chime-interval"),
    chimePreview: document.getElementById("chime-preview"),
    quietEnabled: document.getElementById("quiet-enabled"),
    quietStart: document.getElementById("quiet-start"),
    quietEnd: document.getElementById("quiet-end"),
    bedtimeRow: document.getElementById("bedtime-row"),
  };

  let settings = loadSettings();
  let audioCtx = null;
  let masterGain = null;
  let tickGain = null;
  let chimeGain = null;
  let keepAlive = null;
  let tickSide = 0;
  let nextScheduleWallMs = 0;
  const scheduledKeys = new Set();

  function normalizeSettings(raw) {
    const next = { ...defaults, ...raw };
    if (!ALLOWED_INTERVALS.has(String(next.chimeInterval))) {
      next.chimeInterval = defaults.chimeInterval;
    }
    next.quietStart = normalizeTime(next.quietStart, defaults.quietStart);
    next.quietEnd = normalizeTime(next.quietEnd, defaults.quietEnd);
    return next;
  }

  function normalizeTime(value, fallback) {
    if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return fallback;
    const [h, m] = value.split(":").map(Number);
    if (h > 23 || m > 59) return fallback;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...defaults };
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToUI() {
    els.soundsEnabled.checked = settings.soundsEnabled;
    els.tickEnabled.checked = settings.tickEnabled;
    els.chimeEnabled.checked = settings.chimeEnabled;
    els.chimeInterval.value = settings.chimeInterval;
    els.quietEnabled.checked = settings.quietEnabled;
    els.quietStart.value = settings.quietStart;
    els.quietEnd.value = settings.quietEnd;
    syncControlState();
  }

  function syncControlState() {
    const master = settings.soundsEnabled;
    els.tickEnabled.disabled = !master;
    els.chimeEnabled.disabled = !master;
    els.quietEnabled.disabled = !master;

    const chimeActive = master && settings.chimeEnabled;
    els.chimeInterval.disabled = !chimeActive;
    els.chimePreview.disabled = !chimeActive;

    const quietActive = master && settings.quietEnabled;
    els.quietStart.disabled = !quietActive;
    els.quietEnd.disabled = !quietActive;
    els.bedtimeRow.classList.toggle("is-disabled", !quietActive);
  }

  function timeToMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function isQuietHours(date) {
    if (!settings.quietEnabled) return false;
    const current = date.getHours() * 60 + date.getMinutes();
    const start = timeToMinutes(settings.quietStart);
    const end = timeToMinutes(settings.quietEnd);

    if (start === end) return true;
    if (start > end) return current >= start || current < end;
    return current >= start && current < end;
  }

  function soundsAllowed(date) {
    return settings.soundsEnabled && !isQuietHours(date);
  }

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(audioCtx.destination);

      // Separate buses so toggles mute already-scheduled notes immediately.
      tickGain = audioCtx.createGain();
      tickGain.gain.value = 1;
      tickGain.connect(masterGain);

      chimeGain = audioCtx.createGain();
      chimeGain.gain.value = 1;
      chimeGain.connect(masterGain);

      // Near-silent loop keeps the audio graph alive in background tabs.
      keepAlive = audioCtx.createOscillator();
      const keepGain = audioCtx.createGain();
      keepAlive.frequency.value = 1;
      keepGain.gain.value = 0.00001;
      keepAlive.connect(keepGain);
      keepGain.connect(masterGain);
      keepAlive.start();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    applyLiveGains();
    return audioCtx;
  }

  /** Instant mute/unmute for pre-scheduled audio (toggles + quiet hours). */
  function applyLiveGains(now = new Date()) {
    if (!masterGain || !tickGain || !chimeGain) return;
    const allowed = soundsAllowed(now);
    masterGain.gain.value = settings.soundsEnabled ? 1 : 0;
    tickGain.gain.value = allowed && settings.tickEnabled ? 1 : 0;
    chimeGain.gain.value = allowed && settings.chimeEnabled ? 1 : 0;
  }

  function scheduleTick(when, isTock) {
    if (!audioCtx || !tickGain) return;

    // Classic pendulum escapement: short wood/metal click with a soft body resonance.
    // Tick is a touch brighter; tock is a touch darker — same family, alternating feel.
    const peak = 0.028;
    const clickHz = isTock ? 1450 : 1850;
    const bodyHz = isTock ? 320 : 380;
    const woodHz = isTock ? 620 : 740;

    // Escapement “click” — very short, slightly noisy impulse
    const clickLen = Math.floor(audioCtx.sampleRate * 0.012);
    const clickBuf = audioCtx.createBuffer(1, clickLen, audioCtx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickData.length; i += 1) {
      const env = Math.exp(-i / (clickLen * 0.18));
      clickData[i] = (Math.random() * 2 - 1) * env;
    }
    const click = audioCtx.createBufferSource();
    click.buffer = clickBuf;
    const clickFilter = audioCtx.createBiquadFilter();
    clickFilter.type = "bandpass";
    clickFilter.frequency.value = clickHz;
    clickFilter.Q.value = 3.5;
    const clickGain = audioCtx.createGain();
    clickGain.gain.setValueAtTime(0.0001, when);
    clickGain.gain.exponentialRampToValueAtTime(peak, when + 0.001);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.018);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(tickGain);
    click.start(when);
    click.stop(when + 0.02);

    // Wooden case / pallet body — muted mid tone that dies fast
    const wood = audioCtx.createOscillator();
    const woodGain = audioCtx.createGain();
    wood.type = "triangle";
    wood.frequency.setValueAtTime(woodHz, when);
    wood.frequency.exponentialRampToValueAtTime(woodHz * 0.85, when + 0.05);
    woodGain.gain.setValueAtTime(0.0001, when);
    woodGain.gain.exponentialRampToValueAtTime(peak * 0.45, when + 0.002);
    woodGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
    wood.connect(woodGain);
    woodGain.connect(tickGain);
    wood.start(when);
    wood.stop(when + 0.06);

    // Soft low body thump (movement / case)
    const body = audioCtx.createOscillator();
    const bodyGain = audioCtx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(bodyHz, when);
    body.frequency.exponentialRampToValueAtTime(bodyHz * 0.65, when + 0.06);
    bodyGain.gain.setValueAtTime(0.0001, when);
    bodyGain.gain.exponentialRampToValueAtTime(peak * 0.35, when + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
    body.connect(bodyGain);
    bodyGain.connect(tickGain);
    body.start(when);
    body.stop(when + 0.08);
  }

  function scheduleBellStrike(when, peak) {
    if (!audioCtx || !chimeGain) return;

    const strike = audioCtx.createGain();
    strike.connect(chimeGain);

    // Same family as the tick: short wood/metal hammer hit
    const clickLen = Math.floor(audioCtx.sampleRate * 0.018);
    const clickBuf = audioCtx.createBuffer(1, clickLen, audioCtx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickData.length; i += 1) {
      clickData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (clickLen * 0.2));
    }
    const click = audioCtx.createBufferSource();
    click.buffer = clickBuf;
    const clickFilter = audioCtx.createBiquadFilter();
    clickFilter.type = "bandpass";
    clickFilter.frequency.value = 1600;
    clickFilter.Q.value = 2.2;
    const clickGain = audioCtx.createGain();
    clickGain.gain.setValueAtTime(0.0001, when);
    clickGain.gain.exponentialRampToValueAtTime(peak * 0.55, when + 0.0015);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(strike);
    click.start(when);
    click.stop(when + 0.035);

    // Wooden case bloom under the gong
    const wood = audioCtx.createOscillator();
    const woodGain = audioCtx.createGain();
    wood.type = "triangle";
    wood.frequency.setValueAtTime(280, when);
    wood.frequency.exponentialRampToValueAtTime(220, when + 0.25);
    woodGain.gain.setValueAtTime(0.0001, when);
    woodGain.gain.exponentialRampToValueAtTime(peak * 0.3, when + 0.008);
    woodGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.4);
    wood.connect(woodGain);
    woodGain.connect(strike);
    wood.start(when);
    wood.stop(when + 0.45);

    // Soft gong body — warm, muted, not bright tubular
    BELL_PARTIALS.forEach((partial, index) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const lowpass = audioCtx.createBiquadFilter();
      const freq = BELL_FUNDAMENTAL * partial.ratio * (1 + (index % 2 === 0 ? 0.001 : -0.001));

      osc.type = index === 0 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(freq, when);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.995, when + partial.decay);

      lowpass.type = "lowpass";
      lowpass.frequency.value = 1800;
      lowpass.Q.value = 0.7;

      const amp = peak * partial.gain;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(amp, when + 0.02);
      gain.gain.exponentialRampToValueAtTime(amp * 0.4, when + 0.45);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + partial.decay);

      osc.connect(lowpass);
      lowpass.connect(gain);
      gain.connect(strike);
      osc.start(when);
      osc.stop(when + partial.decay + 0.05);
    });
  }

  function scheduleChimes(when, count) {
    for (let i = 0; i < count; i += 1) {
      const peak = i === 0 ? 0.028 : 0.024;
      scheduleBellStrike(when + i * STRIKE_GAP, peak);
    }
  }

  function strikeCountForMinute(_date, minutes) {
    if (minutes === 0) return 2;
    if (minutes === 15 || minutes === 30 || minutes === 45) return 1;
    return 0;
  }

  function shouldChimeAt(minutes, interval) {
    if (interval === 60) return minutes === 0;
    if (interval === 30) return minutes === 0 || minutes === 30;
    if (interval === 15) {
      return minutes === 0 || minutes === 15 || minutes === 30 || minutes === 45;
    }
    return false;
  }

  function wallToAudioTime(wallMs) {
    const delaySec = (wallMs - Date.now()) / 1000;
    return audioCtx.currentTime + delaySec;
  }

  function secondKey(wallMs) {
    return Math.floor(wallMs / 1000);
  }

  /** Queue ticks/chimes on the AudioContext timeline (keeps playing when the tab is hidden). */
  function scheduleAhead() {
    if (!settings.soundsEnabled) return;
    const ctx = ensureAudio();
    if (!ctx) return;

    const nowMs = Date.now();
    if (!nextScheduleWallMs) {
      nextScheduleWallMs = Math.ceil(nowMs / 1000) * 1000;
    }

    const horizon = nowMs + SCHEDULE_AHEAD_MS;
    while (nextScheduleWallMs <= horizon) {
      const wallMs = nextScheduleWallMs;
      const key = secondKey(wallMs);
      nextScheduleWallMs += 1000;

      if (scheduledKeys.has(key)) continue;
      if (wallMs < nowMs - 50) continue;

      const when = wallToAudioTime(wallMs);
      if (when < ctx.currentTime - 0.02) continue;

      const at = new Date(wallMs);
      if (!soundsAllowed(at)) {
        scheduledKeys.add(key);
        continue;
      }

      // Always queue onto tick/chime buses; live gains mute instantly on toggle.
      scheduleTick(when, tickSide % 2 === 1);
      tickSide += 1;

      const minutes = at.getMinutes();
      const seconds = at.getSeconds();
      const interval = Number(settings.chimeInterval);
      if (seconds === 0 && shouldChimeAt(minutes, interval)) {
        const count = strikeCountForMinute(at, minutes);
        if (count > 0) scheduleChimes(when, count);
      }

      scheduledKeys.add(key);
    }

    // Bound memory: keep recent keys only.
    if (scheduledKeys.size > 120) {
      const minKeep = secondKey(nowMs) - 5;
      for (const key of scheduledKeys) {
        if (key < minKeep) scheduledKeys.delete(key);
      }
    }
  }

  function buildMarks() {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 60; i += 1) {
      const wrap = document.createElement("span");
      wrap.className = "mark-wrap";
      wrap.style.transform = `rotate(${i * 6}deg)`;
      const tick = document.createElement("i");
      if (i % 5 === 0) tick.classList.add("hour-mark");
      wrap.appendChild(tick);
      frag.appendChild(wrap);
    }
    els.marks.appendChild(frag);
  }

  function buildNumerals() {
    if (!els.numerals) return;
    const frag = document.createDocumentFragment();
    for (let hour = 1; hour <= 12; hour += 1) {
      const index = hour % 12; // 12 at top
      const wrap = document.createElement("span");
      wrap.className = "numeral-wrap";
      wrap.style.transform = `rotate(${index * 30}deg)`;
      const text = document.createElement("b");
      text.textContent = String(hour);
      text.style.transform = `rotate(${-index * 30}deg)`;
      wrap.appendChild(text);
      frag.appendChild(wrap);
    }
    els.numerals.appendChild(frag);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function updateVisuals(now) {
    const ms = now.getMilliseconds();
    const s = now.getSeconds() + ms / 1000;
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;

    els.secondHand.style.transform = `rotate(${s * 6}deg)`;
    els.minuteHand.style.transform = `rotate(${m * 6}deg)`;
    els.hourHand.style.transform = `rotate(${h * 30}deg)`;

    const swing = Math.sin(s * Math.PI) * 12;
    els.pendulum.style.transform = `rotate(${swing}deg)`;

    const quiet = isQuietHours(now);
    els.timeReadout.textContent = quiet
      ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} · quiet`
      : `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function onSettingsChange() {
    settings.soundsEnabled = els.soundsEnabled.checked;
    settings.tickEnabled = els.tickEnabled.checked;
    settings.chimeEnabled = els.chimeEnabled.checked;
    settings.chimeInterval = ALLOWED_INTERVALS.has(els.chimeInterval.value)
      ? els.chimeInterval.value
      : "30";
    settings.quietEnabled = els.quietEnabled.checked;
    settings.quietStart = normalizeTime(els.quietStart.value, defaults.quietStart);
    settings.quietEnd = normalizeTime(els.quietEnd.value, defaults.quietEnd);
    els.quietStart.value = settings.quietStart;
    els.quietEnd.value = settings.quietEnd;
    els.chimeInterval.value = settings.chimeInterval;

    if (settings.soundsEnabled) {
      ensureAudio();
      // Resync schedule cursor so new settings apply to future notes.
      nextScheduleWallMs = Math.ceil(Date.now() / 1000) * 1000;
      scheduleAhead();
    }
    applyLiveGains();

    syncControlState();
    saveSettings();
  }

  function previewChime() {
    ensureAudio();
    applyLiveGains();
    if (chimeGain) chimeGain.gain.value = 1;
    if (masterGain) masterGain.gain.value = 1;
    // Preview a half-hour style double strike.
    scheduleChimes(audioCtx.currentTime + 0.02, 2);
  }

  function bindSettings() {
    [
      els.soundsEnabled,
      els.tickEnabled,
      els.chimeEnabled,
      els.chimeInterval,
      els.quietEnabled,
      els.quietStart,
      els.quietEnd,
    ].forEach((el) => {
      el.addEventListener("change", onSettingsChange);
    });
    els.chimePreview.addEventListener("click", previewChime);
  }

  let rafId = 0;

  function paintLoop() {
    updateVisuals(new Date());
    rafId = requestAnimationFrame(paintLoop);
  }

  function startPaintLoop() {
    if (rafId) return;
    rafId = requestAnimationFrame(paintLoop);
  }

  function stopPaintLoop() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Visual clock only while visible; audio is pre-scheduled on the Web Audio clock.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPaintLoop();
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      scheduleAhead();
    } else {
      startPaintLoop();
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      scheduleAhead();
    }
  });

  setInterval(() => {
    if (settings.soundsEnabled) {
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      applyLiveGains();
      scheduleAhead();
    }
  }, SCHEDULER_POLL_MS);

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const isLocal =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (location.protocol !== "https:" && !isLocal) return;

    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Ignore SW registration failures for personal/local use.
    });
  }

  buildMarks();
  buildNumerals();
  applySettingsToUI();
  bindSettings();
  startPaintLoop();
  if (settings.soundsEnabled) {
    ensureAudio();
    scheduleAhead();
  }
  registerServiceWorker();
})();
