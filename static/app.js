import { buildModelId, modelProfiles, sizeLimits, taskModelSummary } from "./studio-models.js?v=20260729-4";
import { estimateCreditCost } from "./studio-credit-costs.js?v=20260729-1";
import { TaskBoard } from "./task-board.js?v=20260729-4";
import { createMentionId, insertMention, mentionLabel, mentionToken } from "./media-references.js?v=20260728-5";

document.addEventListener("DOMContentLoaded", () => {
  const ui = {
    accountStatus: document.getElementById("accountStatus"),
    modelAvailability: document.getElementById("modelAvailability"),
    mediaTypeButtons: Array.from(document.querySelectorAll("[data-media-type]")),
    model: document.getElementById("model"),
    ratio: document.getElementById("ratio"),
    duration: document.getElementById("duration"),
    durationRow: document.getElementById("durationRow"),
    fpsRow: document.getElementById("fpsRow"),
    resolution: document.getElementById("resolution"),
    quality: document.getElementById("quality"),
    qualityRow: document.getElementById("qualityRow"),
    groundSearch: document.getElementById("groundSearch"),
    groundSearchRow: document.getElementById("groundSearchRow"),
    generateAudio: document.getElementById("generateAudio"),
    audioRow: document.getElementById("audioRow"),
    mediaInput: document.getElementById("mediaInput"),
    dropZone: document.getElementById("dropZone"),
    mediaList: document.getElementById("mediaList"),
    mediaCount: document.getElementById("mediaCount"),
    mediaHint: document.getElementById("mediaHint"),
    referenceModeGroup: document.getElementById("referenceModeGroup"),
    referenceModeButtons: Array.from(document.querySelectorAll("[data-reference-mode]")),
    advancedPanel: document.getElementById("advancedPanel"),
    negativePrompt: document.getElementById("negativePrompt"),
    prompt: document.getElementById("prompt"),
    generateBtn: document.getElementById("generateBtn"),
    generateLabel: document.querySelector("#generateBtn span:last-child"),
    requestSummary: document.getElementById("requestSummary"),
    creditCost: document.getElementById("creditCost"),
    formMessage: document.getElementById("formMessage"),
    toast: document.getElementById("toast"),
  };

  const state = {
    mediaType: "video",
    drafts: {
      image: {
        model: "nano-banana2", ratio: "1:1", resolution: "2K", quality: "medium",
        duration: 0, referenceMode: "image", groundSearch: false, files: [],
      },
      video: {
        model: "seedance-fast", ratio: "9:16", resolution: "720p", quality: "",
        duration: 4, referenceMode: "frame", groundSearch: false, files: [],
      },
    },
    apiKey: "",
    models: new Set(),
    activeAccounts: 0,
    initialized: false,
    submitting: false,
    mediaSequences: { image: 0, video: 0, audio: 0 },
  };
  let toastTimer = null;

  const draft = () => state.drafts[state.mediaType];
  const activeProfile = () => modelProfiles[state.mediaType][draft().model];

  function showToast(message, error = false) {
    ui.toast.textContent = String(message || "");
    ui.toast.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.className = "toast"; }, 3200);
  }

  function setFormMessage(message, type = "") {
    ui.formMessage.textContent = String(message || "");
    ui.formMessage.className = type;
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (_) { return { detail: text }; }
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

  function responseError(payload, status) {
    return String(payload?.error?.message || payload?.detail || `生成失败（HTTP ${status}）`);
  }

  async function serviceRequest(url, options = {}) {
    const response = await fetch(url, { ...options, headers: serviceHeaders() });
    const body = await readJson(response);
    if (!response.ok) throw new Error(responseError(body, response.status));
    return body;
  }

  const taskBoard = new TaskBoard({
    request: serviceRequest,
    modelSummary: taskModelSummary,
    notify: showToast,
    mediaType: state.mediaType,
  });

  function modelId() { return buildModelId(state.mediaType, activeProfile(), draft()); }

  function activeLimits() {
    const profile = activeProfile();
    return profile.limitsByReferenceMode?.[draft().referenceMode] || profile.limits;
  }

  function currentCounts() {
    return draft().files.reduce((counts, item) => {
      counts[item.kind] += 1;
      counts.total += 1;
      return counts;
    }, { image: 0, video: 0, audio: 0, total: 0 });
  }

  function filesFitProfile() {
    const counts = currentCounts();
    const limits = activeLimits();
    return Object.keys(limits).every((kind) => counts[kind] <= limits[kind]);
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
    ui.mediaTypeButtons.forEach((button) => { button.disabled = state.submitting; });
  }

  function renderOptions(select, values, selected, label = (value) => value) {
    select.innerHTML = "";
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = label(value);
      select.appendChild(option);
    });
    select.value = String(selected);
  }

  function renderModels() {
    const profiles = modelProfiles[state.mediaType];
    if (!profiles[draft().model]) draft().model = Object.keys(profiles)[0];
    ui.model.innerHTML = "";
    Object.entries(profiles).forEach(([id, profile]) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = profile.label;
      ui.model.appendChild(option);
    });
    ui.model.value = draft().model;
  }

  function renderReferenceModes() {
    const modes = activeProfile().referenceModes || ["frame"];
    if (!modes.includes(draft().referenceMode)) draft().referenceMode = modes[0];
    ui.referenceModeGroup.hidden = state.mediaType === "image" || modes.length < 2;
    ui.referenceModeButtons.forEach((button) => {
      const available = modes.includes(button.dataset.referenceMode);
      button.hidden = !available;
      button.classList.toggle("active", button.dataset.referenceMode === draft().referenceMode);
    });
  }

  function renderControls() {
    renderModels();
    const profile = activeProfile();
    if (!profile.ratios.includes(draft().ratio)) draft().ratio = profile.ratios[0];
    if (!profile.resolutions.includes(draft().resolution)) draft().resolution = profile.resolutions[0];
    renderOptions(
      ui.ratio,
      profile.ratios,
      draft().ratio,
      (value) => value === "auto" ? "自动" : value,
    );
    renderOptions(ui.resolution, profile.resolutions, draft().resolution);
    ui.resolution.disabled = profile.resolutions.length === 1;

    const isImage = state.mediaType === "image";
    ui.durationRow.hidden = isImage;
    ui.fpsRow.hidden = isImage;
    ui.audioRow.hidden = isImage;
    ui.qualityRow.hidden = !isImage || !profile.qualities?.length;
    ui.groundSearchRow.hidden = !isImage || !profile.supportsGroundSearch;
    ui.groundSearch.checked = Boolean(draft().groundSearch);
    if (!isImage) {
      if (!profile.durations.includes(draft().duration)) draft().duration = profile.durations[0];
      renderOptions(ui.duration, profile.durations, draft().duration, (value) => `${value} 秒`);
    }
    if (profile.qualities?.length) {
      if (!profile.qualities.includes(draft().quality)) draft().quality = profile.defaultQuality;
      ui.quality.value = draft().quality;
    }
    renderReferenceModes();
    ui.advancedPanel.hidden = !profile.supportsNegativePrompt;
    ui.prompt.placeholder = isImage
      ? "描述你希望生成的图片内容、构图与风格"
      : "描述你希望生成的视频画面、动作与镜头";
    ui.generateLabel.textContent = `生成${isImage ? "图片" : "视频"}`;
    document.querySelector(".task-panel")?.setAttribute("aria-label", `${isImage ? "图片" : "视频"}任务`);
    renderFiles();
    updateSummary();
  }

  function updateCreditCost() {
    const credits = estimateCreditCost({
      mediaType: state.mediaType,
      model: draft().model,
      resolution: draft().resolution,
      quality: draft().quality,
      duration: draft().duration,
      generateAudio: ui.generateAudio.checked,
    });

    ui.creditCost.hidden = credits == null;
    ui.creditCost.textContent = credits == null ? "" : `使用 ${credits} 个点数`;
  }

  function updateSummary() {
    const profile = activeProfile();
    if (state.mediaType === "image") {
      const quality = profile.qualities?.length
        ? ` · ${{ low: "低", medium: "中", high: "高" }[draft().quality]}质量`
        : "";
      const search = profile.supportsGroundSearch && draft().groundSearch ? " · Google 搜索" : "";
      ui.requestSummary.textContent = `${profile.label} · ${draft().resolution} · ${draft().ratio}${quality}${search}`;
    } else {
      const audioLabel = ui.generateAudio.checked ? "生成音频" : "静音";
      ui.requestSummary.textContent = `${profile.label} · ${draft().duration} 秒 · ${draft().ratio} · ${draft().resolution} · ${audioLabel}`;
    }
    updateCreditCost();
    taskBoard.setDraftRatio(draft().ratio);
    updateAvailability();
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
    return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
  }

  function renderFiles() {
    const counts = currentCounts();
    const limits = activeLimits();
    const profile = activeProfile();
    ui.mediaCount.textContent = `${counts.total} / ${limits.total}`;
    ui.mediaHint.textContent = profile.supportsMedia ? "图片、视频或音频" : `仅图片，最多 ${limits.image} 张`;
    ui.mediaInput.accept = profile.supportsMedia
      ? "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/aac,audio/ogg"
      : "image/png,image/jpeg,image/webp";
    ui.mediaList.innerHTML = "";

    draft().files.forEach((item) => {
      const row = document.createElement("div");
      row.className = "media-item";
      const thumb = document.createElement("div");
      thumb.className = "media-thumb";
      if (item.kind === "image") {
        const image = document.createElement("img");
        image.src = item.previewUrl;
        image.alt = "";
        thumb.appendChild(image);
      } else thumb.textContent = item.kind === "video" ? "VIDEO" : "AUDIO";

      const info = document.createElement("div");
      info.className = "media-info";
      const name = document.createElement("strong");
      name.textContent = item.file.name;
      const meta = document.createElement("span");
      meta.textContent = `${{ image: "图片", video: "视频", audio: "音频" }[item.kind]} · ${sizeLabel(item.file.size)}`;
      info.append(name, meta);

      const mention = document.createElement("button");
      mention.type = "button";
      mention.className = "mention-media";
      mention.textContent = `@${mentionLabel(item)}`;
      mention.title = `在提示词中引用 ${item.file.name}`;
      mention.hidden = !profile.supportsMedia;
      mention.addEventListener("click", () => insertMention(ui.prompt, mentionToken(item)));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-media";
      remove.title = `删除 ${item.file.name}`;
      remove.setAttribute("aria-label", `删除 ${item.file.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(item.previewUrl);
        draft().files = draft().files.filter((candidate) => candidate.id !== item.id);
        renderFiles();
        updateAvailability();
      });
      row.append(thumb, info, mention, remove);
      ui.mediaList.appendChild(row);
    });
  }

  function addFiles(fileList) {
    const counts = currentCounts();
    const limits = activeLimits();
    let rejected = 0;
    for (const file of Array.from(fileList || [])) {
      const kind = fileKind(file);
      const duplicate = draft().files.some((item) => (
        item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified
      ));
      if (duplicate) continue;
      if (!kind || file.size > (sizeLimits[kind] || 0) || counts.total >= limits.total || counts[kind] >= limits[kind]) {
        rejected += 1;
        continue;
      }
      counts[kind] += 1;
      counts.total += 1;
      const sequence = ++state.mediaSequences[kind];
      draft().files.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file, kind, sequence,
        mentionId: createMentionId(kind, sequence),
        previewUrl: URL.createObjectURL(file),
      });
    }
    renderFiles();
    updateAvailability();
    if (rejected) showToast(`${rejected} 个文件因格式、大小或数量限制未加入`, true);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  async function buildRequestBody(prompt, selectedModel, mediaType, requestDraft, profile) {
    const content = [{ type: "text", text: prompt }];
    for (const item of requestDraft.files) {
      const dataUrl = await fileToDataUrl(item.file);
      content.push({
        type: `${item.kind}_url`,
        [`${item.kind}_url`]: { url: dataUrl, mention_id: item.mentionId, label: mentionLabel(item) },
      });
    }
    const body = { model: selectedModel, messages: [{ role: "user", content }] };
    if (mediaType === "image") {
      if (profile.qualities?.length) body.quality = requestDraft.quality;
      if (profile.supportsGroundSearch) body.ground_search = Boolean(requestDraft.groundSearch);
      return body;
    }
    body.generate_audio = ui.generateAudio.checked;
    body.reference_mode = profile.referenceModes?.length > 1
      ? requestDraft.referenceMode
      : profile.supportsMedia && requestDraft.files.length ? "media" : "frame";
    const negativePrompt = ui.negativePrompt.value.trim();
    if (profile.supportsNegativePrompt && negativePrompt) body.negative_prompt = negativePrompt;
    return body;
  }

  async function generate() {
    if (state.submitting) return;
    const prompt = ui.prompt.value.trim();
    if (!prompt) { setFormMessage("请先填写提示词", "error"); ui.prompt.focus(); return; }
    if (state.activeAccounts < 1) { setFormMessage("请先在管理后台添加可用账号", "error"); return; }
    if (!filesFitProfile()) { setFormMessage("当前模型下的参考素材数量超出限制", "error"); return; }
    const selectedModel = modelId();
    if (!state.models.has(selectedModel)) { setFormMessage("当前参数对应的模型不可用", "error"); return; }

    const submittedMediaType = state.mediaType;
    const submittedProfile = activeProfile();
    const submittedDraft = { ...draft(), files: [...draft().files] };
    state.submitting = true;
    ui.generateLabel.textContent = "正在提交";
    setFormMessage(draft().files.length ? "正在读取参考素材" : "正在提交任务", "");
    updateAvailability();
    try {
      const requestBody = await buildRequestBody(
        prompt, selectedModel, submittedMediaType, submittedDraft, submittedProfile,
      );
      const path = submittedMediaType === "image" ? "/v1/images/tasks" : "/v1/videos";
      const response = await fetch(path, { method: "POST", headers: serviceHeaders(), body: JSON.stringify(requestBody) });
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
      ui.generateLabel.textContent = `生成${state.mediaType === "image" ? "图片" : "视频"}`;
      updateAvailability();
    }
  }

  async function initialize() {
    try {
      const authResponse = await fetch("/api/v1/auth/me");
      if (!authResponse.ok) { window.location.href = `/login?next=${encodeURIComponent("/studio")}`; return; }
      const [configResponse, tokensResponse] = await Promise.all([
        adminFetch("/api/v1/config"), adminFetch("/api/v1/tokens"),
      ]);
      const config = await readJson(configResponse);
      const tokenData = await readJson(tokensResponse);
      state.apiKey = String(config.api_key || "");
      state.activeAccounts = Number(tokenData?.summary?.active_accounts ?? tokenData?.summary?.active ?? 0);
      ui.accountStatus.textContent = state.activeAccounts > 0 ? `${state.activeAccounts} 个账号可用` : "没有可用账号";
      ui.accountStatus.className = `account-status ${state.activeAccounts > 0 ? "ready" : "error"}`;
      const modelsResponse = await fetch("/v1/models", { headers: serviceHeaders() });
      const modelsBody = await readJson(modelsResponse);
      if (!modelsResponse.ok) throw new Error(responseError(modelsBody, modelsResponse.status));
      state.models = new Set((modelsBody.data || []).map((item) => String(item.id || "")));
      state.initialized = true;
      updateSummary();
      taskBoard.start();
      if (state.activeAccounts < 1) setFormMessage("请先在管理后台添加可用账号", "error");
    } catch (error) {
      ui.accountStatus.textContent = "连接失败";
      ui.accountStatus.className = "account-status error";
      ui.modelAvailability.textContent = "不可用";
      ui.modelAvailability.className = "availability error";
      ui.generateBtn.disabled = true;
      showToast(error.message || "初始化失败", true);
    }
  }

  ui.mediaTypeButtons.forEach((button) => button.addEventListener("click", () => {
    const nextType = button.dataset.mediaType;
    if (!nextType || nextType === state.mediaType) return;
    state.mediaType = nextType;
    ui.mediaTypeButtons.forEach((item) => item.classList.toggle("active", item === button));
    setFormMessage("", "");
    taskBoard.setMode(state.mediaType, state.initialized);
    renderControls();
  }));
  ui.model.addEventListener("change", () => { draft().model = ui.model.value; renderControls(); });
  ui.ratio.addEventListener("change", () => { draft().ratio = ui.ratio.value; updateSummary(); });
  ui.duration.addEventListener("change", () => { draft().duration = Number(ui.duration.value); updateSummary(); });
  ui.resolution.addEventListener("change", () => { draft().resolution = ui.resolution.value; updateSummary(); });
  ui.quality.addEventListener("change", () => { draft().quality = ui.quality.value; updateSummary(); });
  ui.groundSearch.addEventListener("change", () => {
    draft().groundSearch = ui.groundSearch.checked;
    updateSummary();
  });
  ui.referenceModeButtons.forEach((button) => button.addEventListener("click", () => {
    draft().referenceMode = button.dataset.referenceMode || "frame";
    renderReferenceModes();
    renderFiles();
    updateSummary();
  }));
  ui.generateAudio.addEventListener("change", updateSummary);
  ui.generateBtn.addEventListener("click", generate);

  ui.dropZone.addEventListener("click", () => ui.mediaInput.click());
  ui.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); ui.mediaInput.click(); }
  });
  ui.mediaInput.addEventListener("change", () => { addFiles(ui.mediaInput.files); ui.mediaInput.value = ""; });
  ["dragenter", "dragover"].forEach((name) => ui.dropZone.addEventListener(name, (event) => {
    event.preventDefault(); ui.dropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => ui.dropZone.addEventListener(name, (event) => {
    event.preventDefault(); ui.dropZone.classList.remove("dragging");
  }));
  ui.dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

  window.addEventListener("beforeunload", () => {
    taskBoard.stop();
    Object.values(state.drafts).flatMap((item) => item.files).forEach((item) => URL.revokeObjectURL(item.previewUrl));
  });

  renderControls();
  initialize();
});
