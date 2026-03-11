(function () {
  "use strict";

  var STORAGE_KEYS = {
    settings: "productiveTimer.settings",
    sessions: "productiveTimer.sessions",
    dailyStats: "productiveTimer.dailyStats",
    ui: "productiveTimer.ui"
  };

  var DEFAULTS = {
    theme: "dark",
    timerMode: "pomodoro",
    durations: {
      focus: 25,
      shortBreak: 5,
      longBreak: 15
    },
    volume: 0.72,
    muted: false,
    audio: {
      type: "builtin",
      trackName: "3 AM Coding Session - Lofi Hip Hop Mix",
      builtinSrc: "./assets/productive-timer-default.mp3"
    }
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createStorageAdapter(storage) {
    var available = true;

    function read(key, fallback) {
      if (!storage || !available) {
        return clone(fallback);
      }

      try {
        var raw = storage.getItem(key);
        if (!raw) {
          return clone(fallback);
        }
        return JSON.parse(raw);
      } catch (error) {
        available = false;
        return clone(fallback);
      }
    }

    function write(key, value) {
      if (!storage || !available) {
        return false;
      }

      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        available = false;
        return false;
      }
    }

    function remove(key) {
      if (!storage || !available) {
        return false;
      }

      try {
        storage.removeItem(key);
        return true;
      } catch (error) {
        available = false;
        return false;
      }
    }

    function isAvailable() {
      return !!storage && available;
    }

    return {
      read: read,
      write: write,
      remove: remove,
      isAvailable: isAvailable
    };
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatDuration(totalSeconds) {
    var safe = Math.max(0, Math.floor(totalSeconds || 0));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var seconds = safe % 60;

    if (hours > 0) {
      return pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
    }

    return pad(minutes) + ":" + pad(seconds);
  }

  function formatMinutes(minutes) {
    return Math.round(minutes) + "m";
  }

  function formatDateLabel(dateString) {
    var date = new Date(dateString + "T00:00:00");
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }

  function startOfToday(now) {
    var base = now ? new Date(now) : new Date();
    base.setHours(0, 0, 0, 0);
    return base;
  }

  function toDayKey(date) {
    var localDate = new Date(date);
    return [
      localDate.getFullYear(),
      pad(localDate.getMonth() + 1),
      pad(localDate.getDate())
    ].join("-");
  }

  function getLastNDays(count, now) {
    var today = startOfToday(now);
    var items = [];

    for (var index = count - 1; index >= 0; index -= 1) {
      var cursor = new Date(today);
      cursor.setDate(today.getDate() - index);
      items.push(toDayKey(cursor));
    }

    return items;
  }

  function createStatsEngine(options) {
    var nowProvider = options && options.nowProvider ? options.nowProvider : function () { return new Date(); };

    function buildDailySummary(sessions) {
      var summary = {};

      (sessions || []).forEach(function (session) {
        if (!session || !session.completedAt || session.phase !== "focus" || session.outcome !== "completed") {
          return;
        }

        var dayKey = toDayKey(session.completedAt);

        if (!summary[dayKey]) {
          summary[dayKey] = {
            minutes: 0,
            sessions: 0
          };
        }

        summary[dayKey].minutes += Math.round((session.durationSeconds || 0) / 60);
        summary[dayKey].sessions += 1;
      });

      return summary;
    }

    function getTodayStats(sessions) {
      var todayKey = toDayKey(nowProvider());
      var summary = buildDailySummary(sessions);
      var today = summary[todayKey] || { minutes: 0, sessions: 0 };
      return {
        minutes: today.minutes,
        sessions: today.sessions
      };
    }

    function getStreak(sessions) {
      var summary = buildDailySummary(sessions);
      var streak = 0;
      var day = startOfToday(nowProvider());

      while (summary[toDayKey(day)] && summary[toDayKey(day)].minutes > 0) {
        streak += 1;
        day.setDate(day.getDate() - 1);
      }

      return streak;
    }

    function getSevenDaySeries(sessions) {
      var summary = buildDailySummary(sessions);
      return getLastNDays(7, nowProvider()).map(function (dayKey) {
        return {
          dayKey: dayKey,
          label: formatDateLabel(dayKey),
          minutes: summary[dayKey] ? summary[dayKey].minutes : 0
        };
      });
    }

    return {
      buildDailySummary: buildDailySummary,
      getTodayStats: getTodayStats,
      getStreak: getStreak,
      getSevenDaySeries: getSevenDaySeries
    };
  }

  function mergeSettings(defaults, stored) {
    var merged = clone(defaults);
    var incoming = stored || {};
    merged.theme = incoming.theme || defaults.theme;
    merged.timerMode = incoming.timerMode || defaults.timerMode;
    merged.volume = typeof incoming.volume === "number" ? incoming.volume : defaults.volume;
    merged.muted = typeof incoming.muted === "boolean" ? incoming.muted : defaults.muted;
    merged.durations = {
      focus: incoming.durations && incoming.durations.focus || defaults.durations.focus,
      shortBreak: incoming.durations && incoming.durations.shortBreak || defaults.durations.shortBreak,
      longBreak: incoming.durations && incoming.durations.longBreak || defaults.durations.longBreak
    };
    merged.audio = {
      type: incoming.audio && incoming.audio.type || defaults.audio.type,
      trackName: incoming.audio && incoming.audio.trackName || defaults.audio.trackName,
      builtinSrc: defaults.audio.builtinSrc
    };
    return merged;
  }

  function createTimerEngine(config) {
    var settings = mergeSettings(DEFAULTS, config || {});
    var state = {
      mode: settings.timerMode,
      phase: "focus",
      status: "idle",
      durations: clone(settings.durations),
      elapsedSeconds: 0,
      remainingSeconds: settings.durations.focus * 60,
      activeStartedAt: null,
      cycleCount: 0
    };

    function getPhaseDurationSeconds(phase) {
      if (phase === "shortBreak") {
        return state.durations.shortBreak * 60;
      }
      if (phase === "longBreak") {
        return state.durations.longBreak * 60;
      }
      return state.durations.focus * 60;
    }

    function setMode(mode) {
      state.mode = mode === "countup" ? "countup" : "pomodoro";
      reset();
    }

    function setDurations(nextDurations) {
      state.durations.focus = Math.max(1, Number(nextDurations.focus) || DEFAULTS.durations.focus);
      state.durations.shortBreak = Math.max(1, Number(nextDurations.shortBreak) || DEFAULTS.durations.shortBreak);
      state.durations.longBreak = Math.max(1, Number(nextDurations.longBreak) || DEFAULTS.durations.longBreak);

      if (state.mode === "pomodoro") {
        state.remainingSeconds = getPhaseDurationSeconds(state.phase);
      }
    }

    function start(now) {
      if (state.status === "running") {
        return state;
      }
      state.status = "running";
      state.activeStartedAt = typeof now === "number" ? now : Date.now();
      return state;
    }

    function pause(now) {
      if (state.status !== "running") {
        return state;
      }
      tick(now);
      state.status = "paused";
      state.activeStartedAt = null;
      return state;
    }

    function reset() {
      state.status = "idle";
      state.phase = "focus";
      state.elapsedSeconds = 0;
      state.remainingSeconds = state.mode === "pomodoro" ? getPhaseDurationSeconds("focus") : 0;
      state.activeStartedAt = null;
      return state;
    }

    function advancePhase() {
      if (state.phase === "focus") {
        state.cycleCount += 1;
        state.phase = state.cycleCount % 4 === 0 ? "longBreak" : "shortBreak";
      } else {
        state.phase = "focus";
      }

      state.elapsedSeconds = 0;
      state.remainingSeconds = getPhaseDurationSeconds(state.phase);
      state.activeStartedAt = null;
    }

    function tick(now) {
      if (state.status !== "running" || state.activeStartedAt === null) {
        return { completed: false, advanced: false };
      }

      var reference = typeof now === "number" ? now : Date.now();
      var deltaSeconds = Math.max(0, Math.floor((reference - state.activeStartedAt) / 1000));
      if (deltaSeconds === 0) {
        return { completed: false, advanced: false };
      }

      state.activeStartedAt = reference;

      if (state.mode === "countup") {
        state.elapsedSeconds += deltaSeconds;
        return { completed: false, advanced: false };
      }

      state.remainingSeconds = Math.max(0, state.remainingSeconds - deltaSeconds);
      state.elapsedSeconds += deltaSeconds;

      if (state.remainingSeconds === 0) {
        var completedPhase = state.phase;
        var completedDurationSeconds = getPhaseDurationSeconds(completedPhase);
        advancePhase();
        return {
          completed: true,
          advanced: true,
          completedPhase: completedPhase,
          completedDurationSeconds: completedDurationSeconds
        };
      }

      return { completed: false, advanced: false };
    }

    function skipPhase() {
      if (state.mode !== "pomodoro") {
        reset();
        return state;
      }
      advancePhase();
      state.status = "idle";
      state.activeStartedAt = null;
      return state;
    }

    function getProgress() {
      if (state.mode === "countup") {
        var cycle = state.durations.focus * 60 || 1;
        return Math.min(1, (state.elapsedSeconds % cycle) / cycle);
      }
      var total = getPhaseDurationSeconds(state.phase) || 1;
      return 1 - (state.remainingSeconds / total);
    }

    function snapshot() {
      return clone(state);
    }

    return {
      state: state,
      setMode: setMode,
      setDurations: setDurations,
      start: start,
      pause: pause,
      reset: reset,
      tick: tick,
      skipPhase: skipPhase,
      getProgress: getProgress,
      getPhaseDurationSeconds: getPhaseDurationSeconds,
      snapshot: snapshot
    };
  }

  function createAudioController(options) {
    var audio = options.audioElement;
    var state = {
      sourceType: "builtin",
      trackName: DEFAULTS.audio.trackName,
      sourceUrl: DEFAULTS.audio.builtinSrc,
      loaded: false,
      muted: DEFAULTS.muted,
      volume: DEFAULTS.volume,
      loop: true,
      status: "idle"
    };

    if (audio) {
      audio.loop = true;
      audio.preload = "none";
      audio.volume = state.volume;
      audio.muted = state.muted;
    }

    function loadBuiltin() {
      if (!audio) {
        return false;
      }
      if (audio.src !== state.sourceUrl) {
        audio.src = state.sourceUrl;
      }
      state.loaded = true;
      state.sourceType = "builtin";
      return true;
    }

    function setVolume(volume) {
      state.volume = Math.max(0, Math.min(1, volume));
      if (audio) {
        audio.volume = state.volume;
      }
    }

    function toggleMute() {
      state.muted = !state.muted;
      if (audio) {
        audio.muted = state.muted;
      }
      return state.muted;
    }

    function play() {
      if (!audio) {
        return Promise.resolve({ ok: false, reason: "unsupported" });
      }
      if (!state.loaded) {
        loadBuiltin();
      }
      return audio.play().then(function () {
        state.status = "playing";
        return { ok: true };
      }).catch(function (error) {
        state.status = "blocked";
        return { ok: false, reason: error && error.name ? error.name : "playback-error" };
      });
    }

    function stop() {
      if (!audio) {
        return;
      }
      audio.pause();
      audio.currentTime = 0;
      state.status = "idle";
    }

    function setSeek(percent) {
      if (!audio || !audio.duration || !isFinite(audio.duration)) {
        return;
      }
      audio.currentTime = audio.duration * percent;
    }

    function attachUploadedFile(file) {
      if (!file || !String(file.type || "").startsWith("audio/")) {
        return { ok: false, reason: "invalid-file" };
      }
      if (!audio) {
        return { ok: false, reason: "unsupported" };
      }
      state.sourceType = "custom";
      state.trackName = file.name;
      state.sourceUrl = URL.createObjectURL(file);
      state.loaded = true;
      audio.src = state.sourceUrl;
      return { ok: true };
    }

    function getSnapshot() {
      return {
        sourceType: state.sourceType,
        trackName: state.trackName,
        loaded: state.loaded,
        muted: state.muted,
        volume: state.volume,
        loop: state.loop,
        status: state.status,
        duration: audio && isFinite(audio.duration) ? audio.duration : 0,
        currentTime: audio ? audio.currentTime : 0
      };
    }

    return {
      loadBuiltin: loadBuiltin,
      setVolume: setVolume,
      toggleMute: toggleMute,
      play: play,
      stop: stop,
      setSeek: setSeek,
      attachUploadedFile: attachUploadedFile,
      getSnapshot: getSnapshot
    };
  }

  function createAppEnvironment() {
    var hasDocument = typeof document !== "undefined";
    var storage = createStorageAdapter(typeof window !== "undefined" ? window.localStorage : null);
    var stats = createStatsEngine();
    var savedSettings = mergeSettings(DEFAULTS, storage.read(STORAGE_KEYS.settings, DEFAULTS));
    var sessions = storage.read(STORAGE_KEYS.sessions, []);
    var timer = createTimerEngine(savedSettings);
    var audioElement = hasDocument ? new Audio() : null;
    var audioController = createAudioController({ audioElement: audioElement });
    var uiState = storage.read(STORAGE_KEYS.ui, { bannerDismissed: false });

    if (savedSettings.audio.type === "builtin") {
      audioController.loadBuiltin();
    }
    audioController.setVolume(savedSettings.volume);
    if (savedSettings.muted) {
      audioController.toggleMute();
    }

    return {
      storage: storage,
      stats: stats,
      timer: timer,
      sessions: sessions,
      settings: savedSettings,
      uiState: uiState,
      audioController: audioController,
      audioElement: audioElement
    };
  }

  function createBrowserApp(env) {
    var documentRef = document;
    var root = documentRef.body;
    var banner = documentRef.getElementById("banner");
    var ring = documentRef.getElementById("progress-ring-value");
    var ringRadius = Number(ring.getAttribute("r")) || 96;
    var ringLength = 2 * Math.PI * ringRadius;
    var utilityHideTimer = null;
    var autoplayRetryArmed = false;
    var prefersHover = typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : false;
    var uiState = {
      musicExpanded: false,
      historyExpanded: false,
      utilitiesVisible: !prefersHover
    };

    ring.style.strokeDasharray = String(ringLength);
    ring.style.strokeDashoffset = String(ringLength);

    var els = {
      backgroundVideo: documentRef.querySelector(".video-background video"),
      themeToggle: documentRef.getElementById("theme-toggle"),
      phaseTitle: documentRef.getElementById("phase-title"),
      phaseCaption: documentRef.getElementById("phase-caption"),
      sessionPill: documentRef.getElementById("session-pill"),
      phaseLabel: documentRef.getElementById("phase-label"),
      timerDisplay: documentRef.getElementById("timer-display"),
      timerHint: documentRef.getElementById("timer-hint"),
      modeButtons: documentRef.querySelectorAll("[data-mode]"),
      startButton: documentRef.getElementById("start-button"),
      pauseButton: documentRef.getElementById("pause-button"),
      resetButton: documentRef.getElementById("reset-button"),
      skipButton: documentRef.getElementById("skip-button"),
      focusMinutes: documentRef.getElementById("focus-minutes"),
      shortBreakMinutes: documentRef.getElementById("short-break-minutes"),
      longBreakMinutes: documentRef.getElementById("long-break-minutes"),
      audioStatus: documentRef.getElementById("audio-status"),
      trackName: documentRef.getElementById("track-name"),
      audioPlay: documentRef.getElementById("audio-play"),
      audioStop: documentRef.getElementById("audio-stop"),
      audioMute: documentRef.getElementById("audio-mute"),
      audioUpload: documentRef.getElementById("audio-upload"),
      seekSlider: documentRef.getElementById("seek-slider"),
      volumeSlider: documentRef.getElementById("volume-slider"),
      audioTime: documentRef.getElementById("audio-time"),
      audioSourceNote: documentRef.getElementById("audio-source-note"),
      musicPill: documentRef.querySelector(".music-pill"),
      musicPillToggle: documentRef.getElementById("music-pill-toggle"),
      trackMirrors: documentRef.querySelectorAll("[data-track-mirror]"),
      historyToggle: documentRef.getElementById("history-toggle"),
      historyPanel: documentRef.getElementById("history-panel"),
      utilityTray: documentRef.getElementById("utility-tray"),
      todayTotal: documentRef.getElementById("today-total"),
      todaySessions: documentRef.getElementById("today-sessions"),
      currentStreak: documentRef.getElementById("current-streak"),
      chartBars: documentRef.getElementById("chart-bars"),
      sessionList: documentRef.getElementById("session-list")
    };

    function showBanner(message, tone) {
      banner.hidden = false;
      banner.textContent = message;
      banner.dataset.tone = tone || "warning";
    }

    function hideBanner() {
      banner.hidden = true;
      banner.textContent = "";
      delete banner.dataset.tone;
    }

    function persistSettings() {
      env.settings.theme = root.dataset.theme || env.settings.theme;
      env.settings.timerMode = env.timer.state.mode;
      env.settings.durations = clone(env.timer.state.durations);
      env.settings.volume = env.audioController.getSnapshot().volume;
      env.settings.muted = env.audioController.getSnapshot().muted;
      env.settings.audio.trackName = env.audioController.getSnapshot().trackName;
      env.settings.audio.type = env.audioController.getSnapshot().sourceType;
      if (!env.storage.write(STORAGE_KEYS.settings, env.settings)) {
        showBanner("Browser storage is unavailable, so settings will reset next time.", "warning");
      }
    }

    function persistSessions() {
      if (!env.storage.write(STORAGE_KEYS.sessions, env.sessions)) {
        showBanner("Session history could not be saved in this browser.", "warning");
      } else {
        env.storage.write(STORAGE_KEYS.dailyStats, env.stats.buildDailySummary(env.sessions));
      }
    }

    function applyTheme(theme) {
      root.dataset.theme = theme === "light" ? "light" : "dark";
      els.themeToggle.textContent = root.dataset.theme === "dark" ? "Light mode" : "Dark mode";
    }

    function setUtilitiesVisible(visible) {
      uiState.utilitiesVisible = visible;
      els.utilityTray.classList.toggle("is-hidden", !visible);
      els.utilityTray.classList.toggle("is-visible", visible);
    }

    function scheduleUtilityHide() {
      if (!prefersHover) {
        setUtilitiesVisible(true);
        return;
      }

      window.clearTimeout(utilityHideTimer);
      setUtilitiesVisible(true);
      utilityHideTimer = window.setTimeout(function () {
        setUtilitiesVisible(false);
      }, 2000);
    }

    function renderHistoryVisibility() {
      els.historyPanel.hidden = !uiState.historyExpanded;
      els.historyToggle.setAttribute("aria-expanded", uiState.historyExpanded ? "true" : "false");
      els.historyToggle.textContent = uiState.historyExpanded ? "Hide history" : "View history";
    }

    function renderMusicVisibility() {
      els.musicPill.dataset.musicState = uiState.musicExpanded ? "expanded" : "collapsed";
      els.musicPillToggle.setAttribute("aria-expanded", uiState.musicExpanded ? "true" : "false");
    }

    function renderUtilityVisibility() {
      setUtilitiesVisible(uiState.utilitiesVisible);
    }

    function disarmAutoplayRetry() {
      if (!autoplayRetryArmed) {
        return;
      }
      autoplayRetryArmed = false;
      documentRef.removeEventListener("pointerdown", handleAutoplayRetry, true);
      documentRef.removeEventListener("keydown", handleAutoplayRetry, true);
      documentRef.removeEventListener("touchstart", handleAutoplayRetry, true);
    }

    function handleAutoplayRetry() {
      env.audioController.play().then(function (result) {
        renderAudio();
        if (result.ok) {
          hideBanner();
          disarmAutoplayRetry();
        }
      });
    }

    function armAutoplayRetry() {
      if (autoplayRetryArmed) {
        return;
      }
      autoplayRetryArmed = true;
      documentRef.addEventListener("pointerdown", handleAutoplayRetry, true);
      documentRef.addEventListener("keydown", handleAutoplayRetry, true);
      documentRef.addEventListener("touchstart", handleAutoplayRetry, true);
    }

    function attemptAutoplay() {
      env.audioController.play().then(function (result) {
        renderAudio();
        if (!result.ok) {
          armAutoplayRetry();
          showBanner("Soundtrack will start on your first click or key press. Browsers block automatic audio with sound.", "warning");
        } else {
          disarmAutoplayRetry();
          hideBanner();
        }
      });
    }

    function createSessionRecord(outcome, details) {
      var snapshot = env.timer.snapshot();
      var info = details || {};
      var phase = info.phase || snapshot.phase;
      var seconds;

      if (typeof info.durationSeconds === "number") {
        seconds = info.durationSeconds;
      } else if (snapshot.mode === "countup" || outcome === "interrupted") {
        seconds = snapshot.elapsedSeconds;
      } else {
        seconds = env.timer.getPhaseDurationSeconds(phase);
      }

      return {
        id: "session-" + Date.now(),
        mode: snapshot.mode,
        phase: phase,
        durationSeconds: Math.max(0, Math.round(seconds || 0)),
        completedAt: new Date().toISOString(),
        outcome: outcome
      };
    }

    function recordSession(result) {
      if (!result || result.durationSeconds <= 0) {
        return;
      }
      env.sessions.unshift(result);
      env.sessions = env.sessions.slice(0, 60);
      persistSessions();
      renderStats();
    }

    function renderTimer() {
      var state = env.timer.state;
      var progress = env.timer.getProgress();
      var display = state.mode === "countup"
        ? formatDuration(state.elapsedSeconds)
        : formatDuration(state.remainingSeconds);
      var pill = state.status === "running" ? "Running" : state.status === "paused" ? "Paused" : "Ready";
      var title = state.mode === "countup" ? "Open focus tracker" : state.phase === "focus" ? "Focus block" : state.phase === "shortBreak" ? "Short break" : "Long break";
      var caption = state.mode === "countup"
        ? "Track free-form deep work with no forced stop."
        : state.phase === "focus"
          ? "Pomodoro mode with calm defaults."
          : "Catch your breath, then jump back in.";

      els.phaseTitle.textContent = title;
      els.phaseCaption.textContent = caption;
      els.sessionPill.textContent = pill;
      els.phaseLabel.textContent = state.mode === "countup" ? "Flow" : state.phase.replace("Break", " break");
      els.timerDisplay.textContent = display;
      els.timerHint.textContent = state.mode === "countup"
        ? "Track time until you decide to stop."
        : "Focus and break lengths can be tuned below.";
      ring.style.strokeDashoffset = String(ringLength - (ringLength * progress));
      els.pauseButton.textContent = state.status === "paused" ? "Resume" : "Pause";
      els.pauseButton.disabled = state.status === "idle";
      els.skipButton.disabled = state.mode === "countup";
      els.startButton.hidden = state.status !== "idle";
      els.pauseButton.hidden = state.status === "idle";
      els.pauseButton.innerHTML = state.status === "paused"
        ? '<span class="icon-slot" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 6.5v11l9-5.5z"></path></svg></span>'
        : '<span class="icon-slot" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 6h3.5v12H8zM12.5 6H16v12h-3.5z"></path></svg></span>';
      els.pauseButton.setAttribute("aria-label", state.status === "paused" ? "Resume timer" : "Pause timer");
      root.dataset.timerRunning = state.status === "running" ? "true" : "false";
      root.dataset.phaseTone = state.mode === "pomodoro" && state.phase !== "focus" ? "break" : "focus";
      els.modeButtons.forEach(function (button) {
        button.classList.toggle("is-active", button.dataset.mode === state.mode);
      });
    }

    function renderStats() {
      var today = env.stats.getTodayStats(env.sessions);
      var streak = env.stats.getStreak(env.sessions);
      var series = env.stats.getSevenDaySeries(env.sessions);
      var maxMinutes = Math.max.apply(Math, series.map(function (item) { return item.minutes; }).concat([1]));

      els.todayTotal.textContent = formatMinutes(today.minutes);
      els.todaySessions.textContent = String(today.sessions);
      els.currentStreak.textContent = streak + (streak === 1 ? " day" : " days");
      els.chartBars.innerHTML = "";

      series.forEach(function (item) {
        var wrapper = documentRef.createElement("div");
        wrapper.className = "chart-bar";
        var fill = documentRef.createElement("div");
        fill.className = "chart-bar-fill";
        fill.style.height = Math.max(18, Math.round((item.minutes / maxMinutes) * 140)) + "px";
        fill.title = item.minutes + " minutes";
        var label = documentRef.createElement("span");
        label.textContent = item.label;
        var value = documentRef.createElement("span");
        value.textContent = item.minutes + "m";
        wrapper.appendChild(value);
        wrapper.appendChild(fill);
        wrapper.appendChild(label);
        els.chartBars.appendChild(wrapper);
      });

      els.sessionList.innerHTML = "";
      if (!env.sessions.length) {
        var empty = documentRef.createElement("li");
        empty.className = "session-item";
        empty.innerHTML = "<div><strong>No sessions yet</strong><span>Start a focus block to build your history.</span></div>";
        els.sessionList.appendChild(empty);
        return;
      }

      env.sessions.slice(0, 6).forEach(function (session) {
        var row = documentRef.createElement("li");
        row.className = "session-item";
        var finished = new Date(session.completedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        });
        row.innerHTML = "<div><strong>" + session.mode.toUpperCase() + " · " + formatMinutes(Math.round(session.durationSeconds / 60)) + "</strong><span>" + finished + "</span></div><div><span>" + session.outcome + "</span></div>";
        els.sessionList.appendChild(row);
      });
    }

    function renderAudio() {
      var snapshot = env.audioController.getSnapshot();
      els.trackName.textContent = snapshot.trackName;
      els.trackMirrors.forEach(function (node) {
        node.textContent = snapshot.trackName;
      });
      els.volumeSlider.value = String(Math.round(snapshot.volume * 100));
      els.audioMute.textContent = snapshot.muted ? "Unmute" : "Mute";
      els.audioSourceNote.textContent = snapshot.sourceType === "builtin" ? "Built-in loop" : "Uploaded track";
      els.audioPlay.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5v11l9-5.5z"></path></svg>';
      els.audioPlay.setAttribute("aria-label", "Play audio");
      els.audioStatus.textContent = snapshot.status === "blocked"
        ? "Playback needs a direct user action in this browser."
        : snapshot.status === "playing"
          ? "Looping with focus mode ready."
          : "Built-in track stays idle until you press play.";
      var current = snapshot.currentTime || 0;
      var total = snapshot.duration || 0;
      els.audioTime.textContent = formatDuration(current) + " / " + formatDuration(total);
      els.seekSlider.value = total > 0 ? String(Math.round((current / total) * 100)) : "0";
    }

    function syncInputs() {
      els.focusMinutes.value = String(env.timer.state.durations.focus);
      els.shortBreakMinutes.value = String(env.timer.state.durations.shortBreak);
      els.longBreakMinutes.value = String(env.timer.state.durations.longBreak);
    }

    function applyDurationInputs() {
      env.timer.setDurations({
        focus: Number(els.focusMinutes.value),
        shortBreak: Number(els.shortBreakMinutes.value),
        longBreak: Number(els.longBreakMinutes.value)
      });
      persistSettings();
      renderTimer();
    }

    function playChime() {
      if (!window.AudioContext && !window.webkitAudioContext) {
        return;
      }

      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = new Ctx();
      var oscillator = ctx.createOscillator();
      var gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 660;
      gain.gain.value = 0.001;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      oscillator.stop(ctx.currentTime + 0.26);
    }

    function runTick() {
      var result = env.timer.tick(Date.now());
      renderTimer();
      if (result.completed && env.timer.state.mode === "pomodoro") {
        recordSession(createSessionRecord("completed", {
          phase: result.completedPhase,
          durationSeconds: result.completedDurationSeconds
        }));
        showBanner("Phase complete. You can jump into the next block when ready.", "warning");
        playChime();
      }
    }

    var tickHandle = window.setInterval(runTick, 1000);

    els.themeToggle.addEventListener("click", function () {
      applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
      persistSettings();
      hideBanner();
      scheduleUtilityHide();
    });

    els.modeButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        env.timer.setMode(button.dataset.mode);
        persistSettings();
        renderTimer();
        scheduleUtilityHide();
      });
    });

    els.startButton.addEventListener("click", function () {
      env.timer.start(Date.now());
      renderTimer();
      hideBanner();
      scheduleUtilityHide();
    });

    els.pauseButton.addEventListener("click", function () {
      if (env.timer.state.status === "running") {
        env.timer.pause(Date.now());
      } else {
        env.timer.start(Date.now());
      }
      renderTimer();
      scheduleUtilityHide();
    });

    els.resetButton.addEventListener("click", function () {
      if (env.timer.state.status !== "idle" && env.timer.state.elapsedSeconds > 0) {
        recordSession(createSessionRecord("interrupted"));
      }
      env.timer.reset();
      renderTimer();
      scheduleUtilityHide();
    });

    els.skipButton.addEventListener("click", function () {
      env.timer.skipPhase();
      renderTimer();
      scheduleUtilityHide();
    });

    [els.focusMinutes, els.shortBreakMinutes, els.longBreakMinutes].forEach(function (input) {
      input.addEventListener("change", function () {
        applyDurationInputs();
        scheduleUtilityHide();
      });
    });

    els.audioPlay.addEventListener("click", function () {
      env.audioController.play().then(function (result) {
        renderAudio();
        if (!result.ok) {
          showBanner("Playback is waiting for a direct browser gesture. Press Play again if needed.", "warning");
          armAutoplayRetry();
        } else {
          disarmAutoplayRetry();
        }
      });
      scheduleUtilityHide();
    });

    els.audioStop.addEventListener("click", function () {
      env.audioController.stop();
      renderAudio();
      scheduleUtilityHide();
    });

    els.audioMute.addEventListener("click", function () {
      env.audioController.toggleMute();
      persistSettings();
      renderAudio();
      scheduleUtilityHide();
    });

    els.audioUpload.addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      var result = env.audioController.attachUploadedFile(file);
      if (!result.ok) {
        showBanner("That file is not a supported audio track. Try an MP3, WAV, or M4A file.", "error");
      } else {
        persistSettings();
        renderAudio();
        hideBanner();
      }
      scheduleUtilityHide();
    });

    els.seekSlider.addEventListener("input", function () {
      env.audioController.setSeek(Number(els.seekSlider.value) / 100);
      renderAudio();
      scheduleUtilityHide();
    });

    els.volumeSlider.addEventListener("input", function () {
      env.audioController.setVolume(Number(els.volumeSlider.value) / 100);
      persistSettings();
      renderAudio();
      scheduleUtilityHide();
    });

    els.musicPillToggle.addEventListener("click", function () {
      uiState.musicExpanded = !uiState.musicExpanded;
      renderMusicVisibility();
      scheduleUtilityHide();
    });

    els.historyToggle.addEventListener("click", function () {
      uiState.historyExpanded = !uiState.historyExpanded;
      renderHistoryVisibility();
      scheduleUtilityHide();
    });

    if (env.audioElement) {
      env.audioElement.addEventListener("timeupdate", renderAudio);
      env.audioElement.addEventListener("ended", renderAudio);
      env.audioElement.addEventListener("loadedmetadata", renderAudio);
    }

    if (els.backgroundVideo) {
      els.backgroundVideo.addEventListener("canplay", function () {
        els.backgroundVideo.style.opacity = "1";
      });
      els.backgroundVideo.addEventListener("error", function () {
        els.backgroundVideo.style.opacity = "0";
      });
    }

    if (prefersHover) {
      documentRef.addEventListener("mousemove", scheduleUtilityHide);
      documentRef.addEventListener("keydown", scheduleUtilityHide);
      els.utilityTray.addEventListener("mouseenter", function () {
        window.clearTimeout(utilityHideTimer);
        setUtilitiesVisible(true);
      });
      els.utilityTray.addEventListener("mouseleave", scheduleUtilityHide);
    } else {
      documentRef.addEventListener("touchstart", function () {
        setUtilitiesVisible(true);
      }, { passive: true });
    }

    documentRef.addEventListener("keydown", function (event) {
      if (event.target && /input/i.test(event.target.tagName)) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (env.timer.state.status === "running") {
          env.timer.pause(Date.now());
        } else {
          env.timer.start(Date.now());
        }
        renderTimer();
      } else if (event.key.toLowerCase() === "r") {
        if (env.timer.state.status !== "idle" && env.timer.state.elapsedSeconds > 0) {
          recordSession(createSessionRecord("interrupted"));
        }
        env.timer.reset();
        renderTimer();
      } else if (event.key.toLowerCase() === "t") {
        applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
        persistSettings();
      }
    });

    if (!env.storage.isAvailable()) {
      showBanner("This browser is blocking local storage, so progress will not persist after refresh.", "warning");
    }

    applyTheme(env.settings.theme);
    syncInputs();
    renderTimer();
    renderStats();
    renderAudio();
    renderMusicVisibility();
    renderHistoryVisibility();
    renderUtilityVisibility();
    scheduleUtilityHide();
    window.setTimeout(attemptAutoplay, 180);

    return {
      destroy: function () {
        window.clearInterval(tickHandle);
        window.clearTimeout(utilityHideTimer);
        disarmAutoplayRetry();
      },
      showBanner: showBanner
    };
  }

  window.ProductiveTimerApp = {
    STORAGE_KEYS: STORAGE_KEYS,
    DEFAULTS: DEFAULTS,
    createStorageAdapter: createStorageAdapter,
    createStatsEngine: createStatsEngine,
    createTimerEngine: createTimerEngine,
    createAudioController: createAudioController,
    mergeSettings: mergeSettings,
    formatDuration: formatDuration
  };

  if (typeof document !== "undefined" && document.body && !document.body.dataset.testPage) {
    createBrowserApp(createAppEnvironment());
  }
}());
