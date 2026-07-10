(() => {
  "use strict";

  const STORAGE_KEY = "pendulum-settings-v2";
  const ALLOWED_INTERVALS = new Set(["15", "30", "60"]);
  const STRIKE_GAP = 1.15;
  // Tubular-bell partial ratios (slightly inharmonic — more clock-like than pure tones).
  const BELL_PARTIALS = [
    { ratio: 1, gain: 1, decay: 3.2 },
    { ratio: 2.0, gain: 0.55, decay: 2.4 },
    { ratio: 2.76, gain: 0.35, decay: 2.0 },
    { ratio: 4.07, gain: 0.18, decay: 1.4 },
    { ratio: 5.4, gain: 0.1, decay: 1.0 },
  ];
  const BELL_FUNDAMENTAL = 523.25; // C5 — warm mantel-clock pitch
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
    return audioCtx;
  }

  function scheduleTick(when, isTock) {
    if (!audioCtx || !masterGain) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();

    osc.type = "square";
    osc.frequency.value = isTock ? 780 : 920;
    filter.type = "bandpass";
    filter.frequency.value = isTock ? 900 : 1200;
    filter.Q.value = 4;

    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.045, when + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    osc.start(when);
    osc.stop(when + 0.07);
  }

  function scheduleBellStrike(when, peak) {
    if (!audioCtx || !masterGain) return;

    const strike = audioCtx.createGain();
    strike.connect(masterGain);

    // Soft metallic “hit” transient
    const noiseBuf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.04), audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuf;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 2400;
    noiseFilter.Q.value = 1.2;
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(peak * 0.35, when);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(strike);
    noise.start(when);
    noise.stop(when + 0.05);

    BELL_PARTIALS.forEach((partial, index) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const freq = BELL_FUNDAMENTAL * partial.ratio * (1 + (index % 2 === 0 ? 0.0015 : -0.0015));

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, when);
      // Slight pitch droop after the strike — like a real tube/bell
      osc.frequency.exponentialRampToValueAtTime(freq * 0.997, when + partial.decay);

      const amp = peak * partial.gain;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(amp, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(amp * 0.45, when + 0.35);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + partial.decay);

      osc.connect(gain);
      gain.connect(strike);
      osc.start(when);
      osc.stop(when + partial.decay + 0.05);
    });
  }

  function scheduleChimes(when, count) {
    for (let i = 0; i < count; i += 1) {
      // Slightly softer after the first strike so hour counts don’t blast
      const peak = i === 0 ? 0.025 : 0.02;
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

      if (settings.tickEnabled) {
        scheduleTick(when, tickSide % 2 === 1);
        tickSide += 1;
      }

      if (settings.chimeEnabled) {
        const minutes = at.getMinutes();
        const seconds = at.getSeconds();
        const interval = Number(settings.chimeInterval);
        if (seconds === 0 && shouldChimeAt(minutes, interval)) {
          const count = strikeCountForMinute(at, minutes);
          if (count > 0) scheduleChimes(when, count);
        }
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

    const swing = Math.sin(s * Math.PI) * 14;
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
      if (masterGain) masterGain.gain.value = 1;
      // Resync schedule cursor so new settings apply soon.
      nextScheduleWallMs = Math.ceil(Date.now() / 1000) * 1000;
      scheduleAhead();
    } else if (masterGain) {
      masterGain.gain.value = 0;
    }

    syncControlState();
    saveSettings();
  }

  function previewChime() {
    ensureAudio();
    if (masterGain) masterGain.gain.value = 1;
    // Preview a half-hour style single strike, then a double so both are audible.
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
  applySettingsToUI();
  bindSettings();
  startPaintLoop();
  if (settings.soundsEnabled) {
    ensureAudio();
    scheduleAhead();
  }
  registerServiceWorker();
})();
