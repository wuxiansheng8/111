document.addEventListener("DOMContentLoaded", () => {
  const ui = {
    accountStatus: document.getElementById("accountStatus"),
    modelAvailability: document.getElementById("modelAvailability"),
    versionButtons: Array.from(document.querySelectorAll("[data-version]")),
    ratioButtons: Array.from(document.querySelectorAll("[data-ratio]")),
    duration: document.getElementById("duration"),
    generateAudio: document.getElementById("generateAudio"),
    mediaInput: document.getElementById("mediaInput"),
    dropZone: document.getElementById("dropZone"),
    mediaList: document.getElementById("mediaList"),
    mediaCount: document.getElementById("mediaCount"),
    negativePrompt: document.getElementById("negativePrompt"),
    prompt: document.getElementById("prompt"),
    generateBtn: document.getElementById("generateBtn"),
    requestSummary: document.getElementById("requestSummary"),
    formMessage: document.getElementById("formMessage"),
    resultStage: document.getElementById("resultStage"),
    emptyState: document.getElementById("emptyState"),
    resultVideo: document.getElementById("resultVideo"),
    resultTitle: document.getElementById("resultTitle"),
    statusBadge: document.getElementById("statusBadge"),
    downloadBtn: document.getElementById("downloadBtn"),
    progressPanel: document.getElementById("progressPanel"),
    progressLabel: document.getElementById("progressLabel"),
    progressBar: document.getElementById("progressBar"),
    progressDetail: document.getElementById("progressDetail"),
    elapsedTime: document.getElementById("elapsedTime"),
    toast: document.getElementById("toast"),
  };

  const limits = { image: 9, video: 3, audio: 3, total: 12 };
  const sizeLimits = {
    image: 10 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
  };
  const state = {
    version: "fast",
    ratio: "9:16",
    duration: 4,
    files: [],
    apiKey: "",
    models: new Set(),
    activeAccounts: 0,
    running: false,
    startedAt: 0,
    pollTimer: null,
    runId: 0,
  };

  let toastTimer = null;

  function showToast(message, error = false) {
    ui.toast.textContent = String(message || "");
    ui.toast.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ui.toast.className = "toast";
    }, 3200);
  }

  function setFormMessage(message, type = "") {
    ui.formMessage.textContent = String(message || "");
    ui.formMessage.className = type;
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      return { detail: text };
    }
  }

  async function adminFetch(url, options = {}) {
    const response = await fetch(url, options);
    if (response.status === 401) {
      window.location.href = `/login?next=${encodeURIComponent("/studio")}`;
      throw new Error("登录状态已失效");
    }
    return response;
  }

  function serviceHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
    return headers;
  }

  function modelId() {
    const versionPart = state.version === "fast" ? "-fast" : "";
    return `firefly-seedance2${versionPart}-${state.duration}s-${state.ratio.replace(":", "x")}`;
  }

  function updateSummary() {
    const versionLabel = state.version === "fast" ? "Fast" : "标准版";
    const audioLabel = ui.generateAudio.checked ? "生成音频" : "静音";
    ui.requestSummary.textContent = `${versionLabel} · ${state.duration} 秒 · ${state.ratio} · 720p · ${audioLabel}`;
    ui.resultStage.classList.toggle("portrait-stage", state.ratio === "9:16");
    updateAvailability();
  }

  function updateAvailability() {
    const current = modelId();
    if (!state.models.size) {
      ui.modelAvailability.textContent = "检查中";
      ui.modelAvailability.className = "availability";
      return;
    }
    const available = state.models.has(current);
    ui.modelAvailability.textContent = available ? "可用" : "不可用";
    ui.modelAvailability.className = `availability ${available ? "ready" : "error"}`;
    ui.generateBtn.disabled = state.running || !available || state.activeAccounts < 1;
  }

  function selectButton(buttons, activeButton) {
    buttons.forEach((button) => button.classList.toggle("active", button === activeButton));
  }

  function fileKind(file) {
    const type = String(file.type || "").toLowerCase();
    const name = String(file.name || "").toLowerCase();
    if (type.startsWith("image/") || /\.(png|jpe?g|webp)$/.test(name)) return "image";
    if (type.startsWith("video/") || /\.(mp4|mov)$/.test(name)) return "video";
    if (type.startsWith("audio/") || /\.(mp3|m4a|wav|aac|ogg)$/.test(name)) return "audio";
    return "";
  }

  function sizeLabel(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }

  function mediaTypeLabel(kind) {
    return { image: "图片", video: "视频", audio: "音频" }[kind] || "文件";
  }

  function currentCounts() {
    return state.files.reduce(
      (counts, item) => {
        counts[item.kind] += 1;
        counts.total += 1;
        return counts;
      },
      { image: 0, video: 0, audio: 0, total: 0 },
    );
  }

  function renderFiles() {
    const counts = currentCounts();
    ui.mediaCount.textContent = `${counts.total} / ${limits.total}`;
    ui.mediaList.innerHTML = "";

    state.files.forEach((item) => {
      const row = document.createElement("div");
      row.className = "media-item";

      const thumb = document.createElement("div");
      thumb.className = "media-thumb";
      if (item.kind === "image") {
        const image = document.createElement("img");
        image.src = item.previewUrl;
        image.alt = "";
        thumb.appendChild(image);
      } else {
        thumb.textContent = item.kind === "video" ? "VIDEO" : "AUDIO";
      }

      const info = document.createElement("div");
      info.className = "media-info";
      const name = document.createElement("strong");
      name.textContent = item.file.name;
      const meta = document.createElement("span");
      meta.textContent = `${mediaTypeLabel(item.kind)} · ${sizeLabel(item.file.size)}`;
      info.append(name, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-media";
      remove.title = `删除 ${item.file.name}`;
      remove.setAttribute("aria-label", `删除 ${item.file.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(item.previewUrl);
        state.files = state.files.filter((candidate) => candidate.id !== item.id);
        renderFiles();
      });

      row.append(thumb, info, remove);
      ui.mediaList.appendChild(row);
    });
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const counts = currentCounts();
    let rejected = 0;
    for (const file of incoming) {
      const kind = fileKind(file);
      if (
        !kind
        || file.size > (sizeLimits[kind] || 0)
        || counts.total >= limits.total
        || counts[kind] >= limits[kind]
      ) {
        rejected += 1;
        continue;
      }
      const duplicate = state.files.some((item) => (
        item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified
      ));
      if (duplicate) continue;

      counts[kind] += 1;
      counts.total += 1;
      state.files.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        kind,
        previewUrl: URL.createObjectURL(file),
      });
    }
    renderFiles();
    if (rejected) showToast(`${rejected} 个文件因格式或数量限制未加入`, true);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  function setStatus(status, label) {
    ui.statusBadge.className = `status-badge ${status}`;
    ui.statusBadge.textContent = label;
  }

  function setProgress(value, label, detail, indeterminate = false) {
    ui.progressPanel.hidden = false;
    ui.progressLabel.textContent = label;
    ui.progressDetail.textContent = detail;
    ui.progressBar.classList.toggle("indeterminate", indeterminate);
    if (!indeterminate) ui.progressBar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  }

  function elapsedLabel() {
    const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = (seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  async function pollProgress(runId, selectedModel, promptPrefix) {
    if (!state.running || runId !== state.runId) return;
    ui.elapsedTime.textContent = elapsedLabel();
    try {
      const response = await adminFetch("/api/v1/logs/running?limit=100");
      const body = await readJson(response);
      const items = Array.isArray(body.items) ? body.items : [];
      const startedSeconds = state.startedAt / 1000;
      const match = items.find((item) => (
        item.model === selectedModel
        && Number(item.ts || 0) >= startedSeconds - 8
        && String(item.prompt_preview || "").startsWith(promptPrefix)
      ));
      if (match) {
        const progress = Number(match.task_progress || 0);
        const hasProgress = progress > 0;
        setProgress(
          progress,
          hasProgress ? `正在生成 ${Math.round(progress)}%` : "正在生成",
          match.upstream_job_id ? "上游任务已创建" : "正在上传参考素材",
          !hasProgress,
        );
      }
    } catch (_) {
      // The generation request remains authoritative; polling is best effort.
    }
    state.pollTimer = setTimeout(() => pollProgress(runId, selectedModel, promptPrefix), 2200);
  }

  function extractVideoUrl(payload) {
    const content = String(payload?.choices?.[0]?.message?.content || "");
    const srcMatch = content.match(/<video[^>]+src=['\"]([^'\"]+)['\"]/i);
    if (srcMatch) return srcMatch[1];
    const urlMatch = content.match(/https?:\/\/[^\s'\"<>]+\.(?:mp4|mov)/i);
    return urlMatch ? urlMatch[0] : "";
  }

  function responseError(payload, status) {
    return String(payload?.error?.message || payload?.detail || `生成失败（HTTP ${status}）`);
  }

  async function generateVideo() {
    if (state.running) return;
    const prompt = ui.prompt.value.trim();
    if (!prompt) {
      setFormMessage("请先填写提示词", "error");
      ui.prompt.focus();
      return;
    }
    const selectedModel = modelId();
    if (!state.models.has(selectedModel)) {
      setFormMessage("当前参数对应的模型不可用", "error");
      return;
    }

    state.running = true;
    state.startedAt = Date.now();
    state.runId += 1;
    const runId = state.runId;
    ui.generateBtn.disabled = true;
    ui.downloadBtn.hidden = true;
    ui.resultVideo.hidden = true;
    ui.resultVideo.removeAttribute("src");
    ui.emptyState.hidden = false;
    ui.resultTitle.textContent = `${state.version === "fast" ? "Seedance Fast" : "Seedance 标准版"} · ${state.duration} 秒`;
    setStatus("running", "生成中");
    setFormMessage("请求已提交，请保持页面打开", "");
    setProgress(5, "正在准备", "正在读取参考素材", true);
    ui.elapsedTime.textContent = "00:00";

    try {
      const content = [{ type: "text", text: prompt }];
      for (const item of state.files) {
        const dataUrl = await fileToDataUrl(item.file);
        content.push({
          type: `${item.kind}_url`,
          [`${item.kind}_url`]: { url: dataUrl },
        });
      }

      const requestBody = {
        model: selectedModel,
        messages: [{ role: "user", content }],
        generate_audio: ui.generateAudio.checked,
        reference_mode: state.files.length ? "media" : "frame",
      };
      const negativePrompt = ui.negativePrompt.value.trim();
      if (negativePrompt) requestBody.negative_prompt = negativePrompt;

      const promptPrefix = prompt.replace(/[\r\n]+/g, " ").slice(0, 70);
      pollProgress(runId, selectedModel, promptPrefix);

      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify(requestBody),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(responseError(payload, response.status));

      const videoUrl = extractVideoUrl(payload);
      if (!videoUrl) throw new Error("任务已完成，但响应中没有视频地址");

      stopPolling();
      ui.progressBar.classList.remove("indeterminate");
      setProgress(100, "生成完成", "视频已保存到服务器");
      ui.elapsedTime.textContent = elapsedLabel();
      ui.emptyState.hidden = true;
      ui.resultVideo.src = videoUrl;
      ui.resultVideo.hidden = false;
      ui.downloadBtn.href = videoUrl;
      ui.downloadBtn.hidden = false;
      setStatus("success", "已完成");
      setFormMessage("视频生成成功", "success");
      showToast("视频生成成功");
      ui.resultVideo.load();
    } catch (error) {
      stopPolling();
      setStatus("failed", "失败");
      ui.progressBar.classList.remove("indeterminate");
      ui.progressLabel.textContent = "生成失败";
      ui.progressDetail.textContent = error.message || "请求失败";
      ui.elapsedTime.textContent = elapsedLabel();
      setFormMessage(error.message || "请求失败", "error");
      showToast(error.message || "请求失败", true);
    } finally {
      state.running = false;
      updateAvailability();
    }
  }

  async function initialize() {
    for (let seconds = 4; seconds <= 15; seconds += 1) {
      const option = document.createElement("option");
      option.value = String(seconds);
      option.textContent = `${seconds} 秒`;
      ui.duration.appendChild(option);
    }
    ui.duration.value = "4";

    try {
      const authResponse = await fetch("/api/v1/auth/me");
      if (!authResponse.ok) {
        window.location.href = `/login?next=${encodeURIComponent("/studio")}`;
        return;
      }

      const [configResponse, tokensResponse] = await Promise.all([
        adminFetch("/api/v1/config"),
        adminFetch("/api/v1/tokens"),
      ]);
      const config = await readJson(configResponse);
      const tokenData = await readJson(tokensResponse);
      state.apiKey = String(config.api_key || "");
      const activeCount = Number(tokenData?.summary?.active || 0);
      state.activeAccounts = activeCount;
      ui.accountStatus.textContent = activeCount > 0 ? `${activeCount} 个账号可用` : "没有可用账号";
      ui.accountStatus.className = `account-status ${activeCount > 0 ? "ready" : "error"}`;

      const modelsResponse = await fetch("/v1/models", { headers: serviceHeaders() });
      const modelsBody = await readJson(modelsResponse);
      if (!modelsResponse.ok) throw new Error(responseError(modelsBody, modelsResponse.status));
      state.models = new Set((modelsBody.data || []).map((item) => String(item.id || "")));
      updateSummary();
      if (activeCount < 1) setFormMessage("请先在管理后台添加可用账号", "error");
    } catch (error) {
      ui.accountStatus.textContent = "连接失败";
      ui.accountStatus.className = "account-status error";
      ui.modelAvailability.textContent = "不可用";
      ui.modelAvailability.className = "availability error";
      ui.generateBtn.disabled = true;
      showToast(error.message || "初始化失败", true);
    }
  }

  ui.versionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.version = button.dataset.version || "fast";
      selectButton(ui.versionButtons, button);
      updateSummary();
    });
  });

  ui.ratioButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.ratio = button.dataset.ratio || "9:16";
      selectButton(ui.ratioButtons, button);
      updateSummary();
    });
  });

  ui.duration.addEventListener("change", () => {
    state.duration = Number(ui.duration.value || 4);
    updateSummary();
  });
  ui.generateAudio.addEventListener("change", updateSummary);
  ui.generateBtn.addEventListener("click", generateVideo);

  ui.dropZone.addEventListener("click", () => ui.mediaInput.click());
  ui.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      ui.mediaInput.click();
    }
  });
  ui.mediaInput.addEventListener("change", () => {
    addFiles(ui.mediaInput.files);
    ui.mediaInput.value = "";
  });
  ["dragenter", "dragover"].forEach((name) => {
    ui.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      ui.dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    ui.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      ui.dropZone.classList.remove("dragging");
    });
  });
  ui.dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

  window.addEventListener("beforeunload", () => {
    stopPolling();
    state.files.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  });

  renderFiles();
  updateSummary();
  initialize();
});
