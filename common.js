/* ==========================================================================
   FlameGuard AI — shared code used by every page
   (model request, helpers, alarm sound, history + stats saved in localStorage)
   ========================================================================== */
(() => {
  "use strict";

  /* ---------- Internal engine configuration ---------- */
  const ENGINE = Object.freeze({
    baseUrl: "https://serverless.roboflow.com/",
    modelId: "fire-smoke-detection-odvk6/1",
    apiKey: "JTbMtM49iDmF1YwKsu2J"
  });

  // Extra guards against lights/reflections being mistaken for fire.
  const MIN_FIRE_CONFIDENCE = 0.75;
  const MIN_IMAGE_THREAT_CONFIDENCE = 0.85;
  const THREAT_WINDOW_FRAMES = 3;
  const THREAT_FRAMES_REQUIRED = 2;

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;

  const KEYS = {
    history: "flameguard.history",
    stats: "flameguard.stats",
    settings: "flameguard.settings"
  };
  const DEFAULT_ALERT_EMAIL = "shaheer4798@gmail.com";
  const DEFAULT_SETTINGS = { confidence: 0.75, interval: 2500, accuracy: "high", emailAlerts: "on", alertEmail: DEFAULT_ALERT_EMAIL };
  const MAX_HISTORY = 50;

  const $ = (id) => document.getElementById(id);

  /* ==========================================================================
     localStorage helpers (fall back to memory if storage is blocked)
     ========================================================================== */
  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (error) { console.warn("Could not save to localStorage:", error); }
  }

  let historyItems = [];
  let stats = { completed: 0, alerts: 0 };

  function loadFromStorage() {
    const h = readStore(KEYS.history, []);
    historyItems = Array.isArray(h) ? h.slice(0, MAX_HISTORY) : [];
    const s = readStore(KEYS.stats, {});
    stats = {
      completed: Number(s.completed) || 0,
      alerts: Number(s.alerts) || 0
    };
  }

  /* ==========================================================================
     Small helpers
     ========================================================================== */
  function setConnection(text, state = "idle") {
    const label = $("connectionLabel"), dot = $("connectionDot");
    if (label) label.textContent = text;
    if (dot) dot.className = `status-dot ${state === "idle" ? "" : state}`.trim();
  }

  // Settings are saved so every page uses the same values.
  const SETTING_FIELDS = [
    ["confidence", "confidence", Number],
    ["interval", "interval", Number],
    ["accuracy", "accuracy", String],
    ["emailAlerts", "emailAlerts", String],
    ["alertEmail", "alertEmail", (v) => String(v).trim()]
  ];   // [key in storage, element id, converter]

  const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || "").trim());

  function getSettings() {
    const saved = readStore(KEYS.settings, {});
    const out = {};
    SETTING_FIELDS.forEach(([key, id, convert]) => {
      const el = $(id);
      out[key] = convert(el ? el.value : (saved[key] ?? DEFAULT_SETTINGS[key]));
    });
    return out;
  }

  function initSettings() {
    const saved = readStore(KEYS.settings, {});
    const msg = $("settingsSaved");
    const say = (text, ok = true) => {
      if (!msg) return;
      msg.textContent = text;
      msg.classList.toggle("msg-error", !ok);
      msg.classList.toggle("msg-ok", ok);
    };
    const persist = () => {
      const next = getSettings();
      const emailEl = $("alertEmail");
      if (emailEl && !isValidEmail(next.alertEmail)) {
        // Keep the last valid address instead of saving a broken one.
        next.alertEmail = readStore(KEYS.settings, {}).alertEmail || DEFAULT_ALERT_EMAIL;
        writeStore(KEYS.settings, next);
        say("That email address doesn’t look valid, so it was not saved. Please check it.", false);
        return;
      }
      writeStore(KEYS.settings, next);
      say("✓ Settings saved. They apply to Live Monitoring and Image Analysis.");
    };
    SETTING_FIELDS.forEach(([key, id]) => {
      const el = $(id);
      if (!el) return;
      const value = saved[key] ?? DEFAULT_SETTINGS[key];
      el.value = String(value);
      if (el.tagName === "SELECT" && el.value !== String(value)) el.selectedIndex = [...el.options].findIndex(o => o.defaultSelected);
      el.addEventListener("change", persist);
    });
    const resetBtn = $("resetSettingsBtn");
    if (resetBtn) resetBtn.addEventListener("click", () => {
      SETTING_FIELDS.forEach(([key, id]) => { const el = $(id); if (el) el.value = String(DEFAULT_SETTINGS[key]); });
      persist();
    });

    // Email section of the Settings page
    const setup = $("emailSetupNote");
    if (setup) {
      setup.textContent = emailConfigured()
        ? "Email sending is connected (EmailJS)."
        : "Email sending is not connected yet: add your EmailJS keys in emailConfiguration.js (see README → Email alerts).";
      setup.classList.toggle("msg-ok", emailConfigured());
      setup.classList.toggle("msg-error", !emailConfigured());
    }
    const testBtn = $("testEmailBtn");
    if (testBtn) testBtn.addEventListener("click", async () => {
      const status = $("emailTestStatus");
      const to = getSettings().alertEmail;
      if (!isValidEmail(to)) { status.textContent = "Enter a valid alert email address first."; status.className = "inline-message msg-error"; return; }
      testBtn.disabled = true;
      status.textContent = "Sending test email…"; status.className = "inline-message";
      const result = await sendAlertEmail({ test: true });
      status.textContent = result.message;
      status.className = `inline-message ${result.ok ? "msg-ok" : "msg-error"}`;
      testBtn.disabled = false;
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function isThreatClass(label) {
    // Match actual threat labels only; avoid labels like "fire extinguisher".
    const normalized = String(label || "").toLowerCase().replace(/[_-]+/g, " ").trim();
    return /^(fire|flame|smoke|wildfire|burning|firesmoke|fire smoke|smoke fire)(\s+\d+)?$/.test(normalized);
  }

  function normalizedClass(label) {
    const text = String(label || "unknown").toLowerCase();
    if (/smoke/.test(text)) return "smoke";
    if (/fire|flame|burning|wildfire/.test(text)) return "fire";
    return text;
  }

  function toPredictions(data, minConfidence) {
    return data.predictions
      .filter(p => Number(p.confidence || 0) >= minConfidence)
      .map(p => ({
        label: String(p.class || p.class_name || "unknown"),
        confidence: Number(p.confidence || 0),
        x: Number(p.x || 0), y: Number(p.y || 0),
        width: Number(p.width || 0), height: Number(p.height || 0)
      }));
  }

  /* ==========================================================================
     Model request
     ========================================================================== */
  async function callModel(imageDataUrl, confidence) {
    const base64 = imageDataUrl.split(",")[1];
    const endpoint = `${ENGINE.baseUrl}${encodeURIComponent(ENGINE.modelId).replace("%2F", "/")}` +
      `?api_key=${encodeURIComponent(ENGINE.apiKey)}&confidence=${Math.round(confidence * 100)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: base64
    });

    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The detection service returned an unreadable response (HTTP ${response.status}).`); }

    if (!response.ok) {
      const detail = data?.error || data?.message || `HTTP ${response.status}`;
      throw new Error(String(detail));
    }
    if (!Array.isArray(data.predictions)) {
      throw new Error("The detection service did not return any predictions. Please try again.");
    }
    return data;
  }

  /* ==========================================================================
     Accuracy helpers
     ========================================================================== */
  const MIN_BOX_AREA_RATIO = 0.002;   // live: ignore fire/smoke boxes smaller than 0.2% of the frame

  function boxIou(a, b) {
    const ax1 = a.x - a.width / 2, ay1 = a.y - a.height / 2, ax2 = a.x + a.width / 2, ay2 = a.y + a.height / 2;
    const bx1 = b.x - b.width / 2, by1 = b.y - b.height / 2, bx2 = b.x + b.width / 2, by2 = b.y + b.height / 2;
    const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = iw * ih;
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
  }

  // Combine detections from several passes over the same image (same coordinates).
  // Boxes of the same class that overlap are merged. A detection seen by every pass keeps its
  // average confidence; one seen by only a single pass is scaled down, which removes one-off mistakes.
  function fusePasses(passes, minConfidence) {
    const total = passes.length;
    const all = [];
    passes.forEach((list, pass) => list.forEach(p => all.push({ ...p, pass })));
    all.sort((a, b) => b.confidence - a.confidence);

    const clusters = [];
    all.forEach(p => {
      const cls = normalizedClass(p.label);
      let best = null, bestIou = 0.45;
      clusters.forEach(cl => {
        if (cl.cls !== cls || cl.passes.has(p.pass)) return;
        const v = boxIou(cl.box, p);
        if (v >= bestIou) { best = cl; bestIou = v; }
      });
      if (best) {
        best.members.push(p);
        best.passes.add(p.pass);
        const w = best.members.reduce((s, m) => s + m.confidence, 0);
        const avg = (key) => best.members.reduce((s, m) => s + m[key] * m.confidence, 0) / w;
        best.box = { x: avg("x"), y: avg("y"), width: avg("width"), height: avg("height") };
      } else {
        clusters.push({ cls, label: p.label, members: [p], passes: new Set([p.pass]),
          box: { x: p.x, y: p.y, width: p.width, height: p.height } });
      }
    });

    return clusters
      .map(cl => {
        const mean = cl.members.reduce((s, m) => s + m.confidence, 0) / cl.members.length;
        const agree = cl.passes.size;
        const factor = total > 1 ? 0.72 + 0.28 * (agree - 1) / (total - 1) : 1;
        return { label: cl.label, confidence: mean * factor, ...cl.box, votes: agree };
      })
      .filter(p => p.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  // Analyze an uploaded picture. The image is re-drawn on a canvas first, which fixes phone-photo
  // rotation (EXIF), limits the size and gives the model clean JPEG data. In "high" accuracy mode the
  // picture is checked twice (normal + mirrored) and the two results are fused.
  async function analyzeStillImage(img, settings) {
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const render = (flip) => {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const g = cv.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);          // transparent PNGs become white, not black
      if (flip) { g.translate(w, 0); g.scale(-1, 1); }
      g.drawImage(img, 0, 0, w, h);
      return cv.toDataURL("image/jpeg", 0.92);
    };

    if (settings.accuracy !== "high") {
      const data = await callModel(render(false), settings.confidence);
      return { predictions: toPredictions(data, settings.confidence), width: w, height: h, passes: 1 };
    }

    const floor = Math.min(settings.confidence, 0.3);       // get borderline boxes too, fusion decides
    const [first, second] = await Promise.allSettled([callModel(render(false), floor), callModel(render(true), floor)]);
    if (first.status !== "fulfilled") throw first.reason;
    const normal = toPredictions(first.value, floor);
    if (second.status !== "fulfilled") {                    // mirrored pass failed: fall back to one pass
      return { predictions: normal.filter(p => p.confidence >= settings.confidence), width: w, height: h, passes: 1 };
    }
    const mirrored = toPredictions(second.value, floor).map(p => ({ ...p, x: w - p.x }));   // undo the mirror
    return { predictions: fusePasses([normal, mirrored], settings.confidence), width: w, height: h, passes: 2 };
  }

  /* ==========================================================================
     Shared result widgets
     ========================================================================== */
  function fillDetectionList(container, predictions, emptyText) {
    container.innerHTML = "";
    if (!predictions.length) {
      const empty = document.createElement("div");
      empty.className = "empty-row";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    [...predictions]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8)
      .forEach(p => {
        const cls = normalizedClass(p.label);
        const item = document.createElement("div");
        item.className = `detection-item ${isThreatClass(p.label) ? cls : ""}`.trim();

        const chip = document.createElement("span");
        chip.className = `class-chip ${isThreatClass(p.label) ? cls : ""}`.trim();
        chip.textContent = p.label;

        const pct = document.createElement("strong");
        pct.textContent = `${(p.confidence * 100).toFixed(1)}%`;

        const bar = document.createElement("span");
        bar.className = "detection-bar";
        const fill = document.createElement("i");
        fill.style.width = `${Math.min(100, p.confidence * 100)}%`;
        bar.appendChild(fill);

        item.append(chip, pct, bar);
        container.appendChild(item);
      });
  }

  function setAssessment(prefix, state, symbol, title, text) {
    $(prefix).className = `assessment ${state}`;
    $(`${prefix}Symbol`).textContent = symbol;
    $(`${prefix}Title`).textContent = title;
    $(`${prefix}Text`).textContent = text;
  }

  function restartFlash(element) {
    if (!element) return;
    element.classList.remove("alert-flash");
    void element.offsetWidth;
    element.classList.add("alert-flash");
  }

  /* ==========================================================================
     Location (browser geolocation) — used for live fire alerts
     ========================================================================== */
  let lastLocation = null;
  let locationWatchId = null;

  const formatCoords = (loc) => `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
  // Shows the street address when we have one, otherwise the raw coordinates.
  const formatLocation = (loc) => (loc && loc.address) ? loc.address : formatCoords(loc);

  // Turns coordinates into a readable address using OpenStreetMap Nominatim (free, no API key).
  // Results are cached (about 11 m grid) and requests are spaced out to respect its 1-request/second rule.
  const addressCache = new Map();
  let lastGeocodeAt = 0;
  async function reverseGeocode(loc, timeoutMs = 5000) {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    const key = `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
    if (addressCache.has(key)) return addressCache.get(key);
    const wait = 1100 - (Date.now() - lastGeocodeAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeocodeAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=en&lat=${loc.lat}&lon=${loc.lng}`;
      const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const a = data.address || {};
      // Build a short, readable address; fall back to the full display name.
      const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(" ");
      const parts = [
        a.building || a.amenity || a.shop || a.office || "",
        street,
        a.neighbourhood || a.suburb || a.quarter || "",
        a.city || a.town || a.village || a.county || "",
        a.state || "",
        a.country || ""
      ].filter((v, i, arr) => v && arr.indexOf(v) === i);
      const text = parts.length >= 2 ? parts.join(", ") : (data.display_name || "");
      if (text) addressCache.set(key, text);
      return text || null;
    } catch (error) {
      console.warn("Could not look up the address:", error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  // Adds loc.address (in place) when it can be found. Always resolves with loc.
  async function attachAddress(loc, timeoutMs) {
    if (loc && !loc.address) {
      const text = await reverseGeocode(loc, timeoutMs);
      if (text) loc.address = text;
    }
    return loc;
  }
  const mapsUrl = (loc) => `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;

  // Keeps the newest position while monitoring is on. onChange({status, location?, message?})
  function startLocationWatch(onChange = () => {}) {
    stopLocationWatch();
    if (!navigator.geolocation) { onChange({ status: "unsupported" }); return; }
    onChange({ status: "waiting" });
    locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const prev = lastLocation;
        const fresh = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0), ts: Date.now() };
        // Keep the old address while we are still at (almost) the same spot.
        if (prev && prev.address && Math.abs(prev.lat - fresh.lat) < 0.0002 && Math.abs(prev.lng - fresh.lng) < 0.0002) fresh.address = prev.address;
        lastLocation = fresh;
        onChange({ status: "ok", location: fresh });
        if (!fresh.address) attachAddress(fresh).then(() => { if (lastLocation === fresh && fresh.address) onChange({ status: "ok", location: fresh }); });
      },
      (err) => onChange({ status: err.code === 1 ? "denied" : "error", message: err.message }),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
    );
  }
  function stopLocationWatch() {
    if (locationWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
  // Newest known location (waits a few seconds for one if we have none yet). Resolves null if unavailable.
  async function getLocationNow(maxWaitMs = 4000) {
    const loc = await getRawLocationNow(maxWaitMs);
    return loc ? attachAddress(loc, 3000) : null;
  }
  function getRawLocationNow(maxWaitMs) {
    return new Promise((resolve) => {
      if (lastLocation && Date.now() - lastLocation.ts < 5 * 60 * 1000) { resolve(lastLocation); return; }
      if (!navigator.geolocation) { resolve(null); return; }
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      setTimeout(() => finish(lastLocation), maxWaitMs);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0), ts: Date.now() };
          finish(lastLocation);
        },
        () => finish(lastLocation),
        { enableHighAccuracy: true, timeout: maxWaitMs, maximumAge: 60000 }
      );
    });
  }

  /* ==========================================================================
     Email alerts (EmailJS REST API — no backend needed)
     ========================================================================== */
  const EMAIL_COOLDOWN_MS = 2 * 60 * 1000;      // don't repeat the same class's email within 2 minutes
  const lastEmailAt = {};

  function emailConfigured() {
    const cfg = window.FG_EMAIL || {};
    return [cfg.serviceId, cfg.templateId, cfg.publicKey].every(v => v && !/^YOUR_/.test(v));
  }

  // opts: { classes: ["fire"], confidence, source: "live"|"image", location, detail, test }
  async function sendAlertEmail(opts = {}) {
    const settings = getSettings();
    const to = settings.alertEmail;
    const test = !!opts.test;

    if (!test && settings.emailAlerts !== "on") return { ok: false, skipped: true, message: "Email alerts are turned off in Settings." };
    if (!isValidEmail(to)) return { ok: false, message: "No valid alert email address is set. Add one in Settings." };
    if (!emailConfigured()) return { ok: false, message: "Email alerts are not set up yet. Add your EmailJS keys in emailConfiguration.js." };

    let classes = (opts.classes || []).slice();
    const now = Date.now();
    if (!test) {
      classes = classes.filter(cls => now - (lastEmailAt[cls] || 0) > EMAIL_COOLDOWN_MS);
      if (!classes.length) return { ok: false, skipped: true, message: "Email skipped: an alert email for this was already sent in the last 2 minutes." };
      classes.forEach(cls => { lastEmailAt[cls] = now; });
    }

    const user = window.FG_USER || null;
    const account = user ? `${user.name || "User"} (${user.email || "no email"})` : "Not signed in";
    const when = new Date(now).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
    const what = classes.length ? classes.join(" and ").toUpperCase() : "FIRE/SMOKE";
    const confidenceText = Number.isFinite(opts.confidence) ? `${(opts.confidence * 100).toFixed(1)}%` : "n/a";
    const sourceText = opts.source === "image" ? `Uploaded image${opts.detail ? ` (${opts.detail})` : ""}` : "Live camera";

    let locationText, mapLink;
    if (opts.location) {
      const coordsText = `${formatCoords(opts.location)}${opts.location.accuracy ? ` (accuracy about ±${opts.location.accuracy} m)` : ""}`;
      locationText = opts.location.address ? `${opts.location.address}\nCoordinates: ${coordsText}` : coordsText;
      mapLink = mapsUrl(opts.location);
    } else {
      locationText = opts.source === "image" ? "Not captured for uploaded images" : "Not available (location permission was not granted)";
      mapLink = "";
    }

    const subject = test ? "FlameGuard test email" : `FIRE ALERT: ${what} detected (FlameGuard)`;
    const message = test
      ? "This is a test email from FlameGuard AI. If you can read this, email alerts are working."
      : [
          `FLAMEGUARD ALERT: ${what} DETECTED`,
          "",
          `Detected: ${what} (confidence ${confidenceText})`,
          `Source: ${sourceText}`,
          `Time: ${when}`,
          `Location: ${locationText}`,
          mapLink ? `Map: ${mapLink}` : "",
          `Account: ${account}`,
          "",
          "Please check the area immediately.",
          "This message was sent automatically by a student project and is not a certified fire alarm."
        ].filter((line, i, arr) => line !== "" || arr[i - 1] !== "").join("\n");

    try {
      const cfg = window.FG_EMAIL;
      const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: cfg.serviceId,
          template_id: cfg.templateId,
          user_id: cfg.publicKey,
          template_params: {
            to_email: to, subject, message,
            detected: what, confidence: confidenceText, source: sourceText, time: when,
            location: locationText, map_link: mapLink, account
          }
        })
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (!test) classes.forEach(cls => { delete lastEmailAt[cls]; });   // allow a retry on the next detection
        return { ok: false, message: `Email could not be sent (${response.status}${text ? `: ${text}` : ""}).` };
      }
      return { ok: true, message: test ? `Test email sent to ${to}.` : `Email alert sent to ${to} at ${new Date().toLocaleTimeString()}.` };
    } catch (error) {
      if (!test) classes.forEach(cls => { delete lastEmailAt[cls]; });
      return { ok: false, message: `Email could not be sent: ${error.message}` };
    }
  }

  /* ==========================================================================
     Stats, history and analytics (saved in localStorage, shared by all pages)
     ========================================================================== */
  function refreshStats() {
    if ($("inferenceCount")) $("inferenceCount").textContent = String(stats.completed);
    if ($("alertCount")) $("alertCount").textContent = String(stats.alerts);
  }

  function countAnalysis() {
    stats.completed++;
    writeStore(KEYS.stats, stats);
    refreshStats();
  }

  function registerAlert(label, confidence, source, extra = {}) {
    stats.alerts++;
    writeStore(KEYS.stats, stats);
    refreshStats();
    // Save the clean class name ("fire" / "smoke") so history and analytics always agree.
    addHistory(source === "image" ? "IMAGE ALERT" : "ALERT", normalizedClass(label), confidence, true, source, extra.location || null);
  }

  // Strongest prediction of each class (fire / smoke) among the given threats.
  function bestPerClass(threats) {
    const best = new Map();
    threats.forEach(p => {
      const cls = normalizedClass(p.label);
      if (!best.has(cls) || p.confidence > best.get(cls).confidence) best.set(cls, p);
    });
    return best;
  }

  // One history entry per class. `seen` (a Set) stops the same class being logged twice
  // while one alert is still going on, but lets a NEW class (e.g. smoke after fire) be logged.
  function registerThreatAlerts(threats, source, seen, extra = {}) {
    bestPerClass(threats).forEach((p, cls) => {
      if (seen && seen.has(cls)) return;
      if (seen) seen.add(cls);
      registerAlert(p.label, p.confidence, source, extra);
    });
  }

  // "fire", "smoke" or "fire and smoke"
  function threatName(classes) {
    const list = [...classes].sort();
    return list.length ? list.join(" and ") : "fire/smoke";
  }

  function addHistory(result, label, confidence, threat, source = "live", location = null) {
    const entry = { ts: Date.now(), result, label, confidence, threat, source, location };
    historyItems.unshift(entry);
    historyItems = historyItems.slice(0, MAX_HISTORY);
    writeStore(KEYS.history, historyItems);
    renderHistory();
    renderAnalytics();
    // navauth.js listens for this and also saves the alert to Firestore (users/{uid}/alerts).
    if (threat) window.dispatchEvent(new CustomEvent("fg-alert", { detail: entry }));
  }

  function clearHistory() {
    historyItems = [];
    stats.alerts = 0;
    writeStore(KEYS.history, historyItems);
    writeStore(KEYS.stats, stats);
    refreshStats();
    renderHistory();
    renderAnalytics();
  }

  function renderHistory() {
    const body = $("historyBody");
    if (!body) return;
    body.innerHTML = "";
    if (!historyItems.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">No events recorded yet.</td></tr>';
      return;
    }
    historyItems.forEach(entry => {
      const tr = document.createElement("tr");
      const when = new Date(entry.ts).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
      const values = [when, entry.result, entry.label, `${(entry.confidence * 100).toFixed(1)}%`, entry.location || null];
      const labels = ["Time", "Result", "Class", "Confidence", "Location"];
      values.forEach((value, index) => {
        const td = document.createElement("td");
        td.dataset.label = labels[index];   // used by the mobile card layout
        if (index === 1) {
          const badge = document.createElement("span");
          badge.className = `result-badge ${entry.threat ? "danger" : ""}`.trim();
          badge.textContent = value;
          td.appendChild(badge);
        } else if (index === 4) {
          if (value && Number.isFinite(value.lat) && Number.isFinite(value.lng)) {
            const link = document.createElement("a");
            link.className = "text-link";
            link.href = mapsUrl(value);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = `📍 ${formatLocation(value)}`;
            td.appendChild(link);
          } else {
            td.textContent = entry.source === "image" ? "Not captured (uploaded image)" : "Location not available";
          }
        } else {
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function renderAnalytics() {
    if (!$("anTotal")) return;
    const threats = historyItems.filter(h => h.threat);
    const count = (fn) => threats.filter(fn).length;
    const peak = threats.reduce((m, h) => Math.max(m, h.confidence), 0);
    $("anTotal").textContent = String(threats.length);
    $("anFire").textContent = String(count(h => normalizedClass(h.label) === "fire"));
    $("anSmoke").textContent = String(count(h => normalizedClass(h.label) === "smoke"));
    $("anLive").textContent = String(count(h => h.source !== "image"));
    $("anImage").textContent = String(count(h => h.source === "image"));
    $("anPeak").textContent = threats.length ? `${(peak * 100).toFixed(1)}%` : "—";
  }

  function initHistory() {
    loadFromStorage();
    refreshStats();
    renderHistory();
    renderAnalytics();
    const clearBtn = $("clearHistoryBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearHistory);
    // Keep other open pages/tabs in sync.
    window.addEventListener("storage", (event) => {
      if (event.key === KEYS.history || event.key === KEYS.stats) {
        loadFromStorage();
        refreshStats();
        renderHistory();
        renderAnalytics();
      }
    });
  }

  /* ==========================================================================
     Fire alarm sound (Howler.js). Always on — no sound button.
     Live camera: rings continuously while fire/smoke is confirmed.
     Uploaded image: rings only 2 times.
     If the library or file cannot load, a generated Web Audio beep is used.
     ========================================================================== */
  let liveAlarmActive = false;
  let alarmSoundFailed = false;
  let alarmPlaysLeft = 0;
  let fallbackTimer = null;
  const alarmSound = (typeof Howl !== "undefined")
    ? new Howl({
        src: ["alarm.wav"],
        volume: 0.9,
        html5: true,
        onloaderror: () => { alarmSoundFailed = true; },
        onplayerror: () => { alarmSoundFailed = true; },
        onend: () => {
          if (alarmPlaysLeft === Infinity) return;      // continuous (loop)
          alarmPlaysLeft--;
          if (alarmPlaysLeft > 0) alarmSound.play();
        }
      })
    : null;

  // times = Infinity -> continuous alarm, times = N -> play N times then stop.
  function startAlarm(times) {
    stopAlert();
    alarmPlaysLeft = times;
    if (alarmSound && !alarmSoundFailed) {
      alarmSound.loop(times === Infinity);
      alarmSound.play();
      return;
    }
    let played = 1;
    playFallbackBeep();
    fallbackTimer = window.setInterval(() => {
      if (times !== Infinity && played >= times) { stopAlert(); return; }
      playFallbackBeep();
      played++;
    }, 700);
  }

  function stopAlert() {
    alarmPlaysLeft = 0;
    if (fallbackTimer !== null) { window.clearInterval(fallbackTimer); fallbackTimer = null; }
    if (alarmSound) { alarmSound.loop(false); alarmSound.stop(); }
  }

  function setLiveAlarm(on) {
    if (on && !liveAlarmActive) {
      liveAlarmActive = true;
      startAlarm(Infinity);
    } else if (!on && liveAlarmActive) {
      liveAlarmActive = false;
      stopAlert();
    }
  }

  function playFallbackBeep() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(660, audioContext.currentTime + 0.18);
      gain.gain.setValueAtTime(0.08, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.45);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.45);
      oscillator.onended = () => audioContext.close();
    } catch (error) {
      console.warn("Could not play alert sound:", error);
    }
  }

  /* ---------- Init ---------- */
  initSettings();
  initHistory();

  window.FG = {
    $, MIN_FIRE_CONFIDENCE, MIN_IMAGE_THREAT_CONFIDENCE,
    THREAT_WINDOW_FRAMES, THREAT_FRAMES_REQUIRED,
    MAX_IMAGE_BYTES, IMAGE_TYPES,
    setConnection, getSettings, formatBytes, isThreatClass, normalizedClass, toPredictions,
    callModel, fillDetectionList, setAssessment, restartFlash,
    countAnalysis, registerAlert, registerThreatAlerts, bestPerClass, threatName,
    analyzeStillImage, fusePasses, MIN_BOX_AREA_RATIO,
    startLocationWatch, stopLocationWatch, getLocationNow, formatLocation, formatCoords, reverseGeocode, mapsUrl, sendAlertEmail,
    startAlarm, stopAlert, setLiveAlarm, isLiveAlarmActive: () => liveAlarmActive
  };
})();
