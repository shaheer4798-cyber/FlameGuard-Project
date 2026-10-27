/* ==========================================================================
   FlameGuard AI — Live camera page
   ========================================================================== */
(() => {
  "use strict";
  const {
    $, MIN_FIRE_CONFIDENCE, THREAT_WINDOW_FRAMES, THREAT_FRAMES_REQUIRED,
    setConnection, getSettings, isThreatClass, normalizedClass, toPredictions, callModel,
    fillDetectionList, setAssessment, restartFlash, countAnalysis, registerThreatAlerts, threatName, bestPerClass,
    setLiveAlarm, MIN_BOX_AREA_RATIO,
    startLocationWatch, stopLocationWatch, getLocationNow, formatLocation, mapsUrl, sendAlertEmail
  } = window.FG;

  const video = $("video");
  const canvas = $("overlay");
  const ctx = canvas.getContext("2d");
  const placeholder = $("cameraPlaceholder");

  /* ---------- State ---------- */
  let mediaStream = null;
  let timerId = null;
  let requestBusy = false;
  let monitoring = false;
  let previousAlert = false;
  let lastDetections = [];
  let lastModelSize = { width: undefined, height: undefined };
  let lastThreatConfidence = MIN_FIRE_CONFIDENCE;
  let recentFrames = [];                    // per recent scan: Set of strongly detected classes ("fire"/"smoke")
  let confirmedClasses = new Set();         // classes seen in enough recent scans
  let alertedClasses = new Set();           // classes already written to history during the current alert

  function captureFrame() {
    const c = document.createElement("canvas");
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  }

  /* ==========================================================================
     Location + email notes (small status lines under the camera)
     ========================================================================== */
  function setNote(id, text, kind = "") {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = `help-text ${kind}`.trim();
  }
  function showLocationStatus(info) {
    if (info.status === "ok") {
      const l = info.location;
      setNote("locationNote", `📍 Location ready: ${formatLocation(l)}${l.address ? "" : " (looking up the address…)"}${l.accuracy ? ` (±${l.accuracy} m)` : ""}. It is saved with every fire alert.`, "msg-ok");
    } else if (info.status === "waiting") {
      setNote("locationNote", "📍 Getting your location… please click Allow when the browser asks.");
    } else if (info.status === "denied") {
      setNote("locationNote", "📍 Location permission was denied, so alerts will not include a location. Allow location for this site in your browser settings.", "msg-error");
    } else if (info.status === "unsupported") {
      setNote("locationNote", "📍 This browser does not support location.", "msg-error");
    } else {
      setNote("locationNote", `📍 Location unavailable${info.message ? ` (${info.message})` : ""}.`, "msg-error");
    }
  }

  // Fire/smoke that was detected but whose email has NOT been sent yet. The email only goes out
  // when the user presses the "Send email alert" button.
  let pendingAlert = null;   // { classes: Set, confidence: number, location }

  function hideSendButton() {
    pendingAlert = null;
    const btn = $("sendEmailBtn");
    if (btn) { btn.hidden = true; btn.disabled = false; btn.textContent = "✉ Send email alert"; }
  }

  // Runs once when a NEW fire/smoke class is confirmed: saves it with the location and shows the send button.
  async function handleNewThreats(newThreats) {
    const location = await getLocationNow(4000);
    registerThreatAlerts(newThreats, "live", null, { location });
    const best = bestPerClass(newThreats);
    if (!pendingAlert) pendingAlert = { classes: new Set(), confidence: 0, location };
    best.forEach((p, cls) => {
      pendingAlert.classes.add(cls);
      pendingAlert.confidence = Math.max(pendingAlert.confidence, p.confidence);
    });
    if (location) pendingAlert.location = location;
    const btn = $("sendEmailBtn");
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = "✉ Send email alert";
    setNote("emailNote", `🔥 ${[...pendingAlert.classes].join(" + ")} detected. Press “Send email alert” to notify by email.`, "msg-error");
  }

  async function sendPendingEmail() {
    if (!pendingAlert) return;
    const btn = $("sendEmailBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    setNote("emailNote", "✉ Sending email alert…");
    const location = (await getLocationNow(4000)) || pendingAlert.location;
    const result = await sendAlertEmail({
      classes: [...pendingAlert.classes],
      confidence: pendingAlert.confidence,
      source: "live",
      location
    });
    setNote("emailNote", `✉ ${result.message}`, result.ok ? "msg-ok" : (result.skipped ? "" : "msg-error"));
    if (result.ok) {
      hideSendButton();
    } else {
      btn.disabled = false;
      btn.textContent = "✉ Try sending again";
    }
  }

  /* ==========================================================================
     Live camera monitoring
     ========================================================================== */
  async function startMonitoring() {
    if (!navigator.mediaDevices?.getUserMedia) {
      $("cameraMessage").textContent = "Camera access is unavailable. Open this page on localhost or HTTPS in a modern browser.";
      return;
    }
    const config = getSettings();
    $("startBtn").disabled = true;
    $("cameraMessage").textContent = "Requesting camera permission…";
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },   // back camera on phones; laptops fall back to their webcam
        audio: false
      });
      video.srcObject = mediaStream;
      await video.play();
      video.classList.add("visible");
      placeholder.style.display = "none";
      recentFrames = [];
      confirmedClasses = new Set();
      alertedClasses = new Set();
      previousAlert = false;
      hideSendButton();
      monitoring = true;
      startLocationWatch(showLocationStatus);     // asks for permission, keeps the newest position
      $("stopBtn").disabled = false;
      $("livePill").classList.add("active");
      $("livePill").innerHTML = "<span></span> LIVE";
      $("systemStatus").textContent = "Monitoring";
      $("systemNote").textContent = "Camera active · AI analysis enabled";
      $("resolutionLabel").textContent = `${video.videoWidth} × ${video.videoHeight}`;
      $("fpsLabel").textContent = "AI: STARTING";
      $("cameraMessage").textContent = "Monitoring started. Camera frames are sampled and analyzed automatically.";
      setConnection("MONITORING", "ok");
      timerId = window.setInterval(runInference, config.interval);
      runInference();
    } catch (error) {
      $("cameraMessage").textContent = `Could not start camera: ${error.message}. Check browser permission and ensure the page is on localhost or HTTPS.`;
      $("startBtn").disabled = false;
      stopCameraTracks();
    }
  }

  function stopCameraTracks() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }
    video.srcObject = null;
  }

  function stopMonitoring() {
    monitoring = false;
    hideSendButton();
    recentFrames = [];
    confirmedClasses = new Set();
    alertedClasses = new Set();
    previousAlert = false;
    setLiveAlarm(false);
    stopLocationWatch();
    setNote("locationNote", "");
    lastDetections = [];
    if (timerId !== null) window.clearInterval(timerId);
    timerId = null;
    stopCameraTracks();
    video.classList.remove("visible");
    placeholder.style.display = "block";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;
    $("livePill").classList.remove("active");
    $("livePill").innerHTML = "<span></span> OFFLINE";
    $("systemStatus").textContent = "Standby";
    $("systemNote").textContent = "Camera stopped";
    $("resolutionLabel").textContent = "NO VIDEO INPUT";
    $("fpsLabel").textContent = "AI: IDLE";
    $("cameraMessage").textContent = "Monitoring stopped.";
    $("assessment").className = "assessment neutral";
    $("assessmentSymbol").textContent = "✓";
    $("assessmentTitle").textContent = "Monitoring inactive";
    $("assessmentText").textContent = "Start monitoring to analyze camera frames.";
    if (!requestBusy) setConnection("AI ENGINE STANDBY", "idle");
  }

  async function runInference() {
    if (!monitoring || requestBusy || video.readyState < 2) return;
    requestBusy = true;
    $("fpsLabel").textContent = "AI: ANALYZING";
    try {
      const config = getSettings();
      const data = await callModel(captureFrame(), config.confidence);
      countAnalysis();
      const predictions = toPredictions(data, config.confidence);
      lastDetections = predictions;

      // A single frame is not enough to raise a live alert. Each class (fire / smoke) must show up
      // strongly in at least 2 of the latest 3 frames. Very tiny boxes (sparks, lamps) are ignored.
      const requiredThreatConfidence = Math.max(config.confidence, MIN_FIRE_CONFIDENCE);
      const frameW = Number(data.image?.width) || video.videoWidth;
      const frameH = Number(data.image?.height) || video.videoHeight;
      const frameArea = frameW * frameH;
      const strongNow = new Set(
        predictions
          .filter(p => isThreatClass(p.label) && p.confidence >= requiredThreatConfidence &&
                       (p.width * p.height) / frameArea >= MIN_BOX_AREA_RATIO)
          .map(p => normalizedClass(p.label))
      );
      recentFrames.push(strongNow);
      if (recentFrames.length > THREAT_WINDOW_FRAMES) recentFrames.shift();
      confirmedClasses = new Set(
        ["fire", "smoke"].filter(cls => recentFrames.filter(f => f.has(cls)).length >= THREAT_FRAMES_REQUIRED)
      );

      lastModelSize = { width: data.image?.width, height: data.image?.height };
      lastThreatConfidence = requiredThreatConfidence;

      drawPredictions(predictions, lastModelSize.width, lastModelSize.height, confirmedClasses, requiredThreatConfidence);
      renderLiveAssessment(predictions, {
        confirmedClasses,
        threatConfidence: requiredThreatConfidence
      });
      $("fpsLabel").textContent = "AI: ACTIVE";
      setConnection("AI ENGINE ACTIVE", "ok");
      $("cameraMessage").textContent = `Last analysis completed at ${new Date().toLocaleTimeString()}.`;
    } catch (error) {
      $("fpsLabel").textContent = "AI: ERROR";
      $("cameraMessage").textContent = `Analysis error: ${error.message}`;
      setConnection("SERVICE UNAVAILABLE", "error");
    } finally {
      requestBusy = false;
    }
  }

  function drawPredictions(predictions, modelWidth, modelHeight, confirmed = new Set(), threatConfidence = MIN_FIRE_CONFIDENCE) {
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height || !video.videoWidth) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Account for object-fit: contain letterboxing inside the camera stage.
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const renderedW = video.videoWidth * scale;
    const renderedH = video.videoHeight * scale;
    const offsetX = (rect.width - renderedW) / 2;
    const offsetY = (rect.height - renderedH) / 2;
    const sourceW = Number(modelWidth) || video.videoWidth;
    const sourceH = Number(modelHeight) || video.videoHeight;
    const scaleX = renderedW / sourceW;
    const scaleY = renderedH / sourceH;

    predictions.forEach(p => {
      if (!p.width || !p.height) return;
      const x = offsetX + (p.x - p.width / 2) * scaleX;
      const y = offsetY + (p.y - p.height / 2) * scaleY;
      const w = p.width * scaleX;
      const h = p.height * scaleY;
      const threat = isThreatClass(p.label);
      const cls = normalizedClass(p.label);
      const confirmedBox = threat && confirmed.has(cls) && p.confidence >= threatConfidence;
      const isSmoke = cls === "smoke";
      ctx.strokeStyle = confirmedBox ? (isSmoke ? "#cbd5e1" : "#ff5263") : threat ? "#f0b44d" : "#73a7ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      const prefix = threat && !confirmedBox ? "CHECKING: " : "";
      const label = `${prefix}${p.label} ${(p.confidence * 100).toFixed(0)}%`;
      ctx.font = "600 12px sans-serif";
      const labelW = ctx.measureText(label).width + 12;
      const labelY = Math.max(0, y - 23);
      ctx.fillStyle = confirmedBox ? (isSmoke ? "#475569" : "#b72f43") : threat ? "#8a5c14" : "#275a9e";
      ctx.fillRect(x, labelY, labelW, 22);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 6, labelY + 15);
    });
  }

  /* ==========================================================================
     Live assessment panel
     ========================================================================== */
  function renderLiveAssessment(predictions, options) {
    const threshold = Number(options.threatConfidence || MIN_FIRE_CONFIDENCE);
    const rawThreats = predictions.filter(p => isThreatClass(p.label));
    // Only classes that were confirmed over several frames count as real threats.
    const threats = rawThreats.filter(p =>
      options.confirmedClasses.has(normalizedClass(p.label)) && p.confidence >= threshold
    );
    const top = [...predictions].sort((a, b) => b.confidence - a.confidence)[0];

    $("confidenceValue").textContent = top ? `${(top.confidence * 100).toFixed(1)}%` : "—";
    $("confidenceBar").style.width = top ? `${Math.min(100, top.confidence * 100)}%` : "0%";
    fillDetectionList($("detectionList"), predictions, "No predictions above threshold.");

    const clearAlert = () => { previousAlert = false; alertedClasses = new Set(); setLiveAlarm(false); };

    if (predictions.length === 0) {
      setAssessment("assessment", "safe", "✓", "No target detected",
        "No prediction exceeded the selected threshold in the latest frame.");
      $("latestResult").textContent = "No detection";
      $("latestNote").textContent = "Latest frame analyzed";
      clearAlert();
      return;
    }

    if (rawThreats.length > 0 && threats.length === 0) {
      const recentCount = Math.max(0, ...["fire", "smoke"].map(cls => recentFrames.filter(f => f.has(cls)).length));
      setAssessment("assessment", "neutral", "?", "Unconfirmed prediction",
        `Fire/smoke was suspected, but a live alert needs at least ${Math.round(threshold * 100)}% confidence in ${THREAT_FRAMES_REQUIRED} of the last ${THREAT_WINDOW_FRAMES} camera scans. Lights and reflections may cause false positives.`);
      $("latestResult").textContent = "Checking prediction";
      $("latestNote").textContent = `${recentCount}/${THREAT_WINDOW_FRAMES} recent scans matched`;
      clearAlert();
      return;
    }

    if (threats.length > 0) {
      const classes = new Set(threats.map(p => normalizedClass(p.label)));
      const name = threatName(classes);
      setAssessment("assessment", "danger", "!", `Potential ${name} detected`,
        `A high-confidence ${name} prediction repeated across recent frames. Verify the scene immediately.`);
      $("latestResult").textContent = `Potential ${name}`;
      $("latestNote").textContent = `${threats.length} prediction(s) above threshold`;
      restartFlash($("alertPanel"));
      // Classes that are new in this alert get saved (with location) and emailed; fire and smoke are separate.
      const newThreats = threats.filter(p => !alertedClasses.has(normalizedClass(p.label)));
      newThreats.forEach(p => alertedClasses.add(normalizedClass(p.label)));
      if (newThreats.length) handleNewThreats(newThreats);
      previousAlert = true;
      setLiveAlarm(true);   // keeps ringing until fire/smoke is gone
      return;
    }

    setAssessment("assessment", "neutral", "i", "Other object(s) detected",
      "Predictions were returned, but no fire/smoke class matched.");
    $("latestResult").textContent = "Other objects";
    $("latestNote").textContent = `${predictions.length} prediction(s)`;
    clearAlert();
  }

  /* ---------- Event wiring ---------- */
  $("startBtn").addEventListener("click", startMonitoring);
  $("stopBtn").addEventListener("click", stopMonitoring);
  $("sendEmailBtn").addEventListener("click", sendPendingEmail);

  // Settings live on their own page; show what is currently in use.
  (function showSettingsNote() {
    const s = getSettings();
    $("settingsNote").innerHTML =
      `Using confidence threshold ${Math.round(s.confidence * 100)}% and a scan every ${s.interval / 1000} s. ` +
      '<a class="text-link" href="settings.html">Change settings</a>';
  })();

  // Keep live boxes aligned when the window is resized.
  window.addEventListener("resize", () => {
    if (video.videoWidth && lastDetections.length) {
      drawPredictions(lastDetections, lastModelSize.width, lastModelSize.height, confirmedClasses, lastThreatConfidence);
    }
  });
  window.addEventListener("beforeunload", stopCameraTracks);
})();
