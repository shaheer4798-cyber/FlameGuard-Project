/* ==========================================================================
   FlameGuard AI — Image analysis page
   ========================================================================== */
(() => {
  "use strict";
  const {
    $, MIN_IMAGE_THREAT_CONFIDENCE, MAX_IMAGE_BYTES, IMAGE_TYPES,
    setConnection, getSettings, formatBytes, isThreatClass, normalizedClass,
    fillDetectionList, setAssessment, restartFlash, countAnalysis, registerThreatAlerts, threatName,
    analyzeStillImage, startAlarm, isLiveAlarmActive, bestPerClass, sendAlertEmail
  } = window.FG;

  const uploadCanvas = $("uploadCanvas");
  const uploadCtx = uploadCanvas.getContext("2d");
  const uploadStage = $("uploadStage");

  let selectedImage = null;     // File
  let selectedImageEl = null;   // loaded HTMLImageElement
  let selectedDataUrl = null;
  let imageBusy = false;

  function showThresholdNote() {
    const cfg = getSettings();
    const pct = Math.round(cfg.confidence * 100);
    const mode = cfg.accuracy === "high" ? "High accuracy (image is checked twice)" : "Standard (single check)";
    $("thresholdNote").textContent =
      `Confidence threshold: ${pct}% · Mode: ${mode}. ` +
      `A fire/smoke warning for a single image needs at least ${Math.round(MIN_IMAGE_THREAT_CONFIDENCE * 100)}%.`;
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the selected image."));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not display the selected image."));
      img.src = dataUrl;
    });
  }

  function paintUploadedImage(predictions = [], modelWidth, modelHeight) {
    if (!selectedImageEl) return;
    const img = selectedImageEl;
    uploadCanvas.width = img.naturalWidth;
    uploadCanvas.height = img.naturalHeight;
    uploadCtx.clearRect(0, 0, uploadCanvas.width, uploadCanvas.height);
    uploadCtx.drawImage(img, 0, 0);

    const sx = uploadCanvas.width / (Number(modelWidth) || uploadCanvas.width);
    const sy = uploadCanvas.height / (Number(modelHeight) || uploadCanvas.height);

    predictions.forEach(p => {
      if (!p.width || !p.height) return;
      const x = (p.x - p.width / 2) * sx;
      const y = (p.y - p.height / 2) * sy;
      const w = p.width * sx, h = p.height * sy;
      const threat = isThreatClass(p.label);
      const cls = normalizedClass(p.label);
      // A still image cannot be cross-checked over time, so threat boxes are labelled "VERIFY".
      const color = threat ? (cls === "smoke" ? "#64748b" : "#e5484d") : "#237de4";
      uploadCtx.strokeStyle = color;
      uploadCtx.lineWidth = Math.max(3, uploadCanvas.width / 400);
      uploadCtx.strokeRect(x, y, w, h);
      const label = `${threat ? "VERIFY: " : ""}${p.label} ${(p.confidence * 100).toFixed(0)}%`;
      uploadCtx.font = `bold ${Math.max(16, uploadCanvas.width / 55)}px sans-serif`;
      const labelWidth = uploadCtx.measureText(label).width + 14;
      const labelHeight = Math.max(27, uploadCanvas.width / 30);
      const labelY = Math.max(0, y - labelHeight);
      uploadCtx.fillStyle = color;
      uploadCtx.fillRect(x, labelY, labelWidth, labelHeight);
      uploadCtx.fillStyle = "#fff";
      uploadCtx.fillText(label, x + 7, Math.max(17, y - 7));
    });

    $("uploadEmpty").style.display = "none";
    uploadCanvas.style.display = "block";
    uploadStage.classList.add("has-image");
  }

  function resetImageResults() {
    setAssessment("imageVerdict", "neutral", "▧", "No image analyzed yet",
      "Upload an image and run the analysis to see the result here.");
    $("imgCount").textContent = "—";
    $("imgThreats").textContent = "—";
    $("imgTime").textContent = "—";
    $("imgConfidenceValue").textContent = "—";
    $("imgConfidenceBar").style.width = "0%";
    fillDetectionList($("imageDetectionList"), [], "Detections will be listed here.");
  }

  function setImageBusy(busy) {
    imageBusy = busy;
    $("scanOverlay").hidden = !busy;
    $("analyzeImageBtn").disabled = busy || !selectedImage;
    $("clearImageBtn").disabled = busy || !selectedImage;
    $("imageFile").disabled = busy;
    $("chooseBtn").classList.toggle("is-disabled", busy);
    $("analyzeImageBtn").textContent = busy ? "Analyzing…" : "⌕ Analyze image";
    if (busy) {
      $("systemStatus").textContent = "Analyzing";
      $("systemNote").textContent = "AI is scanning the image";
      setAssessment("imageVerdict", "loading", "", "Analyzing image…", "The AI is scanning your image for fire and smoke.");
      $("imageVerdictSymbol").innerHTML = '<i class="spinner"></i>';
    } else {
      $("systemStatus").textContent = "Ready";
      $("systemNote").textContent = selectedImage ? "Image loaded" : "Waiting for an image";
    }
  }

  async function handleImageFile(file) {
    if (!file || imageBusy) return;
    if (!IMAGE_TYPES.test(file.type)) {
      $("uploadMessage").textContent = "Please select a JPG, PNG, or WebP image.";
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      $("uploadMessage").textContent = "Please select an image smaller than 10 MB.";
      return;
    }
    try {
      const dataUrl = await readImageFile(file);
      const img = await loadImage(dataUrl);
      selectedImage = file;
      selectedDataUrl = dataUrl;
      selectedImageEl = img;

      $("fileName").textContent = file.name;
      $("fileDims").textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      $("fileSize").textContent = formatBytes(file.size);
      $("fileMeta").hidden = false;
      $("analyzeImageBtn").disabled = false;
      $("clearImageBtn").disabled = false;
      $("systemNote").textContent = "Image loaded";
      $("uploadMessage").textContent = "Image ready. Click Analyze image to run the detection.";
      resetImageResults();
      paintUploadedImage();
    } catch (error) {
      $("uploadMessage").textContent = error.message;
    }
  }

  function clearImage() {
    if (imageBusy) return;
    selectedImage = null;
    selectedImageEl = null;
    selectedDataUrl = null;
    $("imageFile").value = "";
    uploadCtx.clearRect(0, 0, uploadCanvas.width, uploadCanvas.height);
    uploadCanvas.style.display = "none";
    $("uploadEmpty").style.display = "";
    uploadStage.classList.remove("has-image");
    $("fileMeta").hidden = true;
    $("analyzeImageBtn").disabled = true;
    $("clearImageBtn").disabled = true;
    $("systemNote").textContent = "Waiting for an image";
    $("uploadMessage").textContent = "Select an image, then click Analyze image.";
    resetImageResults();
  }

  async function analyzeUploadedImage() {
    if (!selectedImage || !selectedImageEl || imageBusy) return;
    const config = getSettings();
    const threshold = Math.max(config.confidence, MIN_IMAGE_THREAT_CONFIDENCE);
    setImageBusy(true);
    $("uploadMessage").textContent = config.accuracy === "high"
      ? "Analyzing image (2 checks for better accuracy)…" : "Analyzing image…";
    const startedAt = performance.now();
    try {
      const result = await analyzeStillImage(selectedImageEl, config);
      const elapsed = performance.now() - startedAt;
      countAnalysis();
      const predictions = result.predictions;
      paintUploadedImage(predictions, result.width, result.height);
      setImageBusy(false);
      renderImageResult(predictions, threshold, elapsed);
      $("uploadMessage").textContent =
        `Analysis complete: ${predictions.length} prediction(s) above the threshold` +
        (result.passes > 1 ? " (combined from 2 checks)." : ".");
      setConnection("AI ENGINE ACTIVE", "ok");
    } catch (error) {
      setImageBusy(false);
      setAssessment("imageVerdict", "danger", "!", "Analysis failed", error.message);
      $("uploadMessage").textContent = `Image analysis failed: ${error.message}`;
      setConnection("SERVICE UNAVAILABLE", "error");
    }
  }

  // Email the alert (no location for uploaded images) and show the result under the buttons.
  async function emailImageAlert(strongThreats) {
    const note = $("emailNote");
    const best = bestPerClass(strongThreats);
    note.textContent = "✉ Sending email alert…";
    note.className = "help-text";
    const result = await sendAlertEmail({
      classes: [...best.keys()],
      confidence: Math.max(...[...best.values()].map(p => p.confidence)),
      source: "image",
      detail: selectedImage ? selectedImage.name : ""
    });
    note.textContent = `✉ ${result.message}`;
    note.className = `help-text ${result.ok ? "msg-ok" : (result.skipped ? "" : "msg-error")}`.trim();
  }

  function renderImageResult(predictions, threshold, elapsedMs) {
    const rawThreats = predictions.filter(p => isThreatClass(p.label));
    const strongThreats = rawThreats.filter(p => p.confidence >= threshold);
    const top = [...predictions].sort((a, b) => b.confidence - a.confidence)[0];
    const pct = Math.round(threshold * 100);

    $("imgCount").textContent = String(predictions.length);
    $("imgThreats").textContent = String(rawThreats.length);
    $("imgTime").textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
    $("imgConfidenceValue").textContent = top ? `${(top.confidence * 100).toFixed(1)}%` : "—";
    $("imgConfidenceBar").style.width = top ? `${Math.min(100, top.confidence * 100)}%` : "0%";
    fillDetectionList($("imageDetectionList"), predictions, "No predictions above threshold.");

    if (predictions.length === 0) {
      setAssessment("imageVerdict", "safe", "✓", "No fire or smoke detected",
        "No prediction exceeded the selected threshold in this image.");
      $("latestResult").textContent = "No detection";
      $("latestNote").textContent = "Uploaded image";
      return;
    }

    if (strongThreats.length > 0) {
      const name = threatName(new Set(strongThreats.map(p => normalizedClass(p.label))));
      setAssessment("imageVerdict", "danger", "!", `Potential ${name} detected`,
        `The model predicts ${name} in this image. Verify manually; a single image cannot be cross-checked across frames.`);
      $("latestResult").textContent = `Potential ${name}`;
      $("latestNote").textContent = `Uploaded image · ${strongThreats.length} prediction(s)`;
      restartFlash($("imageVerdict"));
      registerThreatAlerts(strongThreats, "image");              // fire and smoke are logged separately
      emailImageAlert(strongThreats);
      if (!isLiveAlarmActive()) startAlarm(2);   // uploaded image: alarm plays only 2 times
      return;
    }

    if (rawThreats.length > 0) {
      const name = threatName(new Set(rawThreats.map(p => normalizedClass(p.label))));
      setAssessment("imageVerdict", "warn", "?", `Possible ${name} — verify manually`,
        `The model suspects ${name}, but this single image must reach ${pct}% confidence to raise a warning. Lights and reflections may cause false positives.`);
      $("latestResult").textContent = "Checking prediction";
      $("latestNote").textContent = "Uploaded image · verify manually";
      return;
    }

    setAssessment("imageVerdict", "neutral", "i", "Other object(s) detected",
      "The model returned predictions, but no fire/smoke class matched.");
    $("latestResult").textContent = "Other objects";
    $("latestNote").textContent = `Uploaded image · ${predictions.length} prediction(s)`;
  }

  /* ---------- Event wiring ---------- */
  $("imageFile").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";            // allow re-selecting the same file
    handleImageFile(file);
  });
  $("analyzeImageBtn").addEventListener("click", analyzeUploadedImage);
  $("clearImageBtn").addEventListener("click", clearImage);

  // Drag & drop
  ["dragenter", "dragover"].forEach(type => uploadStage.addEventListener(type, (event) => {
    event.preventDefault();
    if (!imageBusy) uploadStage.classList.add("dragging");
  }));
  ["dragleave", "dragend"].forEach(type => uploadStage.addEventListener(type, () => {
    uploadStage.classList.remove("dragging");
  }));
  uploadStage.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadStage.classList.remove("dragging");
    handleImageFile(event.dataTransfer?.files?.[0]);
  });

  // Paste from clipboard
  window.addEventListener("paste", (event) => {
    const item = [...(event.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    if (item) handleImageFile(item.getAsFile());
  });

  showThresholdNote();
  window.addEventListener("storage", showThresholdNote);
  resetImageResults();
})();
