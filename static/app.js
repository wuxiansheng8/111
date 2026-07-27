import { modelProfiles, sizeLimits, taskModelSummary } from "./studio-models.js?v=20260728-4";
import { VideoTaskBoard } from "./task-board.js?v=20260728-4";
import { createMentionId, insertMention, mentionLabel, mentionToken } from "./media-references.js?v=20260728-5";

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
    toast: document.getElementById("toast"),
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
    mediaSequences: { image: 0, video: 0, audio: 0 },
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

  async function serviceRequest(url, options = {}) {
    const response = await fetch(url, { ...options, headers: serviceHeaders() });
    const body = await readJson(response);
    if (!response.ok) throw new Error(responseError(body, response.status));
    return body;
  }

  const taskBoard = new VideoTaskBoard({
    request: serviceRequest,
    modelSummary: taskModelSummary,
    notify: showToast,
  });

  function modelId() {
    return `${activeProfile().prefix}-${state.duration}s-${state.ratio.replace(":", "x")}`;
  }

  function updateSummary() {
    const profile = activeProfile();
    const audioLabel = ui.generateAudio.checked ? "生成音频" : "静音";
    ui.requestSummary.textContent = `${profile.label} · ${state.duration} 秒 · ${state.ratio} · ${profile.resolution} · ${audioLabel}`;
    ui.resolution.textContent = profile.resolution;
    ui.advancedPanel.hidden = !profile.supportsNegativePrompt;
    taskBoard.setDraftRatio(state.ratio);
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

      const mention = document.createElement("button");
      mention.type = "button";
      mention.className = "mention-media";
      mention.textContent = `@${mentionLabel(item)}`;
      mention.title = `在提示词中引用 ${item.file.name}`;
      mention.hidden = !activeProfile().supportsMedia;
      mention.addEventListener("click", () => insertMention(ui.prompt, mentionToken(item)));

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

      row.append(thumb, info, mention, remove);
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
      const sequence = ++state.mediaSequences[kind];
      state.files.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        kind,
        sequence,
        mentionId: createMentionId(kind, sequence),
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

  function responseError(payload, status) {
    return String(payload?.error?.message || payload?.detail || `生成失败（HTTP ${status}）`);
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
        [`${item.kind}_url`]: {
          url: dataUrl,
          mention_id: item.mentionId,
          label: mentionLabel(item),
        },
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

      taskBoard.add(payload);
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
      taskBoard.start();
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
    taskBoard.stop();
    state.files.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  });

  renderDurations();
  renderFiles();
  updateSummary();
  initialize();
});
