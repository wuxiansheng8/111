document.addEventListener("DOMContentLoaded", () => {
  const ui = {
    accountStatus: document.getElementById("accountStatus"),
    modelAvailability: document.getElementById("modelAvailability"),
    model: document.getElementById("model"),
    ratioButtons: Array.from(document.querySelectorAll("[data-ratio]")),
    duration: document.getElementById("duration"),
    resolution: document.getElementById("resolution"),
    generateAudio: document.getElementById("generateAudio"),
    mediaInput: document.getElementById("mediaInput"),
    dropZone: document.getElementById("dropZone"),
    mediaList: document.getElementById("mediaList"),
    mediaCount: document.getElementById("mediaCount"),
    mediaHint: document.getElementById("mediaHint"),
    advancedPanel: document.getElementById("advancedPanel"),
    negativePrompt: document.getElementById("negativePrompt"),
    prompt: document.getElementById("prompt"),
    generateBtn: document.getElementById("generateBtn"),
    generateLabel: document.querySelector("#generateBtn span:last-child"),
    requestSummary: document.getElementById("requestSummary"),
    formMessage: document.getElementById("formMessage"),
    resultStage: document.getElementById("resultStage"),
    emptyState: document.getElementById("emptyState"),
    emptyTitle: document.querySelector("#emptyState strong"),
    emptyDetail: document.querySelector("#emptyState span:last-child"),
    resultVideo: document.getElementById("resultVideo"),
    resultTitle: document.getElementById("resultTitle"),
    statusBadge: document.getElementById("statusBadge"),
    downloadBtn: document.getElementById("downloadBtn"),
    progressPanel: document.getElementById("progressPanel"),
    progressLabel: document.getElementById("progressLabel"),
    progressBar: document.getElementById("progressBar"),
    progressDetail: document.getElementById("progressDetail"),
    elapsedTime: document.getElementById("elapsedTime"),
    taskList: document.getElementById("taskList"),
    taskCount: document.getElementById("taskCount"),
    toast: document.getElementById("toast"),
  };

  const modelProfiles = {
    "seedance-standard": {
      label: "Seedance 2.0 标准版",
      prefix: "firefly-seedance2",
      durations: Array.from({ length: 12 }, (_, index) => index + 4),
      resolution: "720p",
      supportsMedia: true,
      supportsNegativePrompt: true,
      limits: { image: 9, video: 3, audio: 3, total: 12 },
    },
    "seedance-fast": {
      label: "Seedance 2.0 Fast",
      prefix: "firefly-seedance2-fast",
      durations: Array.from({ length: 12 }, (_, index) => index + 4),
      resolution: "720p",
      supportsMedia: true,
      supportsNegativePrompt: true,
      limits: { image: 9, video: 3, audio: 3, total: 12 },
    },
    kling3: {
      label: "Kling 3.0",
      prefix: "firefly-kling3",
      durations: [5, 10, 15],
      resolution: "720p",
      supportsMedia: false,
      supportsNegativePrompt: false,
      limits: { image: 2, video: 0, audio: 0, total: 2 },
    },
    "kling-o3": {
      label: "Kling 3.0 Omni",
      prefix: "firefly-kling-o3",
      durations: [5, 15],
      resolution: "1080p",
      supportsMedia: false,
      supportsNegativePrompt: false,
      limits: { image: 2, video: 0, audio: 0, total: 2 },
    },
  };
  const sizeLimits = {
    image: 10 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
  };
  const state = {
    model: "seedance-fast",
    ratio: "9:16",
    duration: 4,
    files: [],
    apiKey: "",
    models: new Set(),
    activeAccounts: 0,
    submitting: false,
    tasks: new Map(),
    selectedTaskId: "",
    pollTimer: null,
  };

  let toastTimer = null;

  function activeProfile() {
    return modelProfiles[state.model];
  }

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
    return `${activeProfile().prefix}-${state.duration}s-${state.ratio.replace(":", "x")}`;
  }

  function updateSummary() {
    const profile = activeProfile();
    const audioLabel = ui.generateAudio.checked ? "生成音频" : "静音";
    ui.requestSummary.textContent = `${profile.label} · ${state.duration} 秒 · ${state.ratio} · ${profile.resolution} · ${audioLabel}`;
    ui.resolution.textContent = profile.resolution;
    ui.advancedPanel.hidden = !profile.supportsNegativePrompt;
    if (!state.selectedTaskId) {
      ui.resultStage.classList.toggle("portrait-stage", state.ratio === "9:16");
    }
    renderFiles();
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
    ui.generateBtn.disabled = state.submitting || !available || state.activeAccounts < 1 || !filesFitProfile();
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

  function filesFitProfile() {
    const counts = currentCounts();
    const limits = activeProfile().limits;
    return Object.keys(limits).every((kind) => counts[kind] <= limits[kind]);
  }

  function renderFiles() {
    const counts = currentCounts();
    const limits = activeProfile().limits;
    ui.mediaCount.textContent = `${counts.total} / ${limits.total}`;
    const supportsMedia = activeProfile().supportsMedia;
    ui.mediaHint.textContent = supportsMedia ? "图片、视频或音频" : "仅图片，最多 2 张";
    ui.mediaInput.accept = supportsMedia
      ? "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/aac,audio/ogg"
      : "image/png,image/jpeg,image/webp";
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
    updateAvailability();
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const counts = currentCounts();
    const limits = activeProfile().limits;
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
    if (indeterminate) ui.progressBar.style.removeProperty("width");
    else ui.progressBar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  }

  function elapsedLabel(task) {
    const started = Number(task?.started_at || task?.created_at || Date.now() / 1000) * 1000;
    const ended = Number(task?.completed_at || Date.now() / 1000) * 1000;
    const seconds = Math.max(0, Math.floor((ended - started) / 1000));
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = (seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function responseError(payload, status) {
    return String(payload?.error?.message || payload?.detail || `生成失败（HTTP ${status}）`);
  }

  function taskModelSummary(model) {
    const profiles = Object.values(modelProfiles).sort((a, b) => b.prefix.length - a.prefix.length);
    const profile = profiles.find((item) => String(model || "").startsWith(`${item.prefix}-`));
    if (!profile) return String(model || "未知模型");
    const suffix = String(model).slice(profile.prefix.length + 1);
    const match = suffix.match(/^(\d+)s-(\d+)x(\d+)$/);
    return match ? `${profile.label} · ${match[1]} 秒 · ${match[2]}:${match[3]}` : profile.label;
  }

  async function buildRequestBody(prompt, selectedModel) {
    const profile = activeProfile();
    const files = [...state.files];
    const generateAudio = ui.generateAudio.checked;
    const negativePrompt = ui.negativePrompt.value.trim();
    const content = [{ type: "text", text: prompt }];
    for (const item of files) {
      const dataUrl = await fileToDataUrl(item.file);
      content.push({
        type: `${item.kind}_url`,
        [`${item.kind}_url`]: { url: dataUrl },
      });
    }

    const body = {
      model: selectedModel,
      messages: [{ role: "user", content }],
      generate_audio: generateAudio,
      reference_mode: profile.supportsMedia && files.length ? "media" : "frame",
    };
    if (profile.supportsNegativePrompt && negativePrompt) body.negative_prompt = negativePrompt;
    return body;
  }

  function taskStatusLabel(task) {
    if (task.status === "queued") return task.queue_position ? `排队第 ${task.queue_position} 位` : "排队中";
    return {
      running: "生成中",
      succeeded: "已完成",
      failed: "失败",
      cancelled: "已取消",
    }[task.status] || task.status;
  }

  function taskStatusClass(status) {
    return { succeeded: "success", queued: "queued", running: "running" }[status] || "failed";
  }

  function showTask(task) {
    if (!task) return;
    const videoUrl = String(task.result_url || "");
    ui.resultTitle.textContent = taskModelSummary(task.model);
    ui.resultStage.classList.toggle("portrait-stage", String(task.model || "").endsWith("-9x16"));
    ui.elapsedTime.textContent = elapsedLabel(task);
    setStatus(taskStatusClass(task.status), taskStatusLabel(task));
    ui.downloadBtn.hidden = true;
    ui.resultVideo.hidden = true;
    ui.resultVideo.removeAttribute("src");
    ui.emptyState.hidden = false;

    if (task.status === "succeeded" && videoUrl) {
      setProgress(100, "生成完成", "视频已保存到服务器");
      ui.emptyState.hidden = true;
      ui.resultVideo.src = videoUrl;
      ui.resultVideo.hidden = false;
      ui.downloadBtn.href = videoUrl;
      ui.downloadBtn.hidden = false;
      ui.resultVideo.load();
      return;
    }
    if (task.status === "running") {
      ui.emptyTitle.textContent = "正在生成";
      ui.emptyDetail.textContent = task.account_name ? `账号：${task.account_name}` : "已分配生成账号";
      setProgress(task.progress || 5, "正在生成", ui.emptyDetail.textContent, true);
      return;
    }
    if (task.status === "queued") {
      ui.emptyTitle.textContent = "等待空闲账号";
      ui.emptyDetail.textContent = taskStatusLabel(task);
      setProgress(0, "排队中", ui.emptyDetail.textContent, true);
      return;
    }
    const message = task.error || (task.status === "cancelled" ? "任务已取消" : "视频生成失败");
    ui.emptyTitle.textContent = task.status === "cancelled" ? "任务已取消" : "生成失败";
    ui.emptyDetail.textContent = message;
    setProgress(0, ui.emptyTitle.textContent, message);
  }

  function selectTask(taskId) {
    state.selectedTaskId = String(taskId || "");
    renderTasks();
    showTask(state.tasks.get(state.selectedTaskId));
  }

  async function cancelTask(taskId) {
    const response = await fetch(`/v1/videos/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      headers: serviceHeaders(),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(responseError(body, response.status));
    state.tasks.set(body.id, body);
    renderTasks();
    if (state.selectedTaskId === body.id) showTask(body);
  }

  function renderTasks() {
    const tasks = Array.from(state.tasks.values()).sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    const running = tasks.filter((task) => task.status === "running").length;
    const queued = tasks.filter((task) => task.status === "queued").length;
    ui.taskCount.textContent = `${tasks.length} 个任务${running ? ` · ${running} 生成中` : ""}${queued ? ` · ${queued} 排队` : ""}`;
    ui.taskList.innerHTML = "";
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "task-empty";
      empty.textContent = "提交后可继续添加任务";
      ui.taskList.appendChild(empty);
      return;
    }

    tasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = `task-item${task.id === state.selectedTaskId ? " active" : ""}`;
      row.addEventListener("click", () => selectTask(task.id));

      const status = document.createElement("span");
      status.className = `task-state ${task.status}`;
      status.textContent = taskStatusLabel(task);
      const info = document.createElement("div");
      info.className = "task-info";
      const model = document.createElement("strong");
      model.textContent = taskModelSummary(task.model);
      const prompt = document.createElement("span");
      prompt.textContent = task.prompt_preview || "无提示词摘要";
      info.append(model, prompt);
      const actions = document.createElement("div");
      actions.className = "task-actions";
      if (task.status === "queued") {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "task-action cancel";
        cancel.title = "取消排队";
        cancel.setAttribute("aria-label", "取消排队");
        cancel.textContent = "×";
        cancel.addEventListener("click", async (event) => {
          event.stopPropagation();
          try {
            await cancelTask(task.id);
          } catch (error) {
            showToast(error.message || "取消失败", true);
          }
        });
        actions.appendChild(cancel);
      }
      row.append(status, info, actions);
      ui.taskList.appendChild(row);
    });
  }

  async function refreshTasks() {
    stopPolling();
    try {
      const response = await fetch("/v1/videos?limit=100", { headers: serviceHeaders() });
      const body = await readJson(response);
      if (!response.ok) throw new Error(responseError(body, response.status));
      const tasks = Array.isArray(body.data) ? body.data : [];
      state.tasks = new Map(tasks.map((task) => [String(task.id), task]));
      if (!state.selectedTaskId || !state.tasks.has(state.selectedTaskId)) {
        state.selectedTaskId = String(tasks[0]?.id || "");
      }
      renderTasks();
      if (state.selectedTaskId) showTask(state.tasks.get(state.selectedTaskId));
    } catch (error) {
      showToast(error.message || "任务状态读取失败", true);
    } finally {
      state.pollTimer = setTimeout(refreshTasks, 2500);
    }
  }

  async function generateVideo() {
    if (state.submitting) return;
    const prompt = ui.prompt.value.trim();
    if (!prompt) {
      setFormMessage("请先填写提示词", "error");
      ui.prompt.focus();
      return;
    }
    if (state.activeAccounts < 1) {
      setFormMessage("请先在管理后台添加可用账号", "error");
      return;
    }
    if (!filesFitProfile()) {
      setFormMessage(`${activeProfile().label} 仅支持最多 2 张参考图，请删除其他素材`, "error");
      return;
    }
    const selectedModel = modelId();
    if (!state.models.has(selectedModel)) {
      setFormMessage("当前参数对应的模型不可用", "error");
      return;
    }

    state.submitting = true;
    ui.generateLabel.textContent = "正在提交";
    setFormMessage("正在上传参考素材", "");
    updateAvailability();
    try {
      const requestBody = await buildRequestBody(prompt, selectedModel);
      const response = await fetch("/v1/videos", {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify(requestBody),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(responseError(payload, response.status));

      state.tasks.set(String(payload.id), payload);
      state.selectedTaskId = String(payload.id);
      renderTasks();
      showTask(payload);
      setFormMessage("任务已提交，可以继续添加任务", "success");
      showToast("任务已进入队列");
    } catch (error) {
      const message = error?.message || "提交失败";
      setFormMessage(message, "error");
      showToast(message, true);
    } finally {
      state.submitting = false;
      ui.generateLabel.textContent = "生成视频";
      updateAvailability();
    }
  }

  async function initialize() {
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
      const activeCount = Number(tokenData?.summary?.active_accounts ?? tokenData?.summary?.active ?? 0);
      state.activeAccounts = activeCount;
      ui.accountStatus.textContent = activeCount > 0 ? `${activeCount} 个账号可用` : "没有可用账号";
      ui.accountStatus.className = `account-status ${activeCount > 0 ? "ready" : "error"}`;

      const modelsResponse = await fetch("/v1/models", { headers: serviceHeaders() });
      const modelsBody = await readJson(modelsResponse);
      if (!modelsResponse.ok) throw new Error(responseError(modelsBody, modelsResponse.status));
      state.models = new Set((modelsBody.data || []).map((item) => String(item.id || "")));
      updateSummary();
      refreshTasks();
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

  function renderDurations() {
    const durations = activeProfile().durations;
    ui.duration.innerHTML = "";
    durations.forEach((seconds) => {
      const option = document.createElement("option");
      option.value = String(seconds);
      option.textContent = `${seconds} 秒`;
      ui.duration.appendChild(option);
    });
    state.duration = durations.includes(state.duration) ? state.duration : durations[0];
    ui.duration.value = String(state.duration);
  }

  ui.model.addEventListener("change", () => {
    state.model = ui.model.value;
    renderDurations();
    const compatible = filesFitProfile();
    setFormMessage(compatible ? "" : "当前模型仅支持最多 2 张参考图，请删除其他素材", compatible ? "" : "error");
    updateSummary();
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

  renderDurations();
  renderFiles();
  updateSummary();
  initialize();
});
