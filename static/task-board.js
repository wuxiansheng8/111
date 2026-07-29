const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class TaskBoard {
  constructor({ request, modelSummary, notify, mediaType = "video" }) {
    this.request = request;
    this.modelSummary = modelSummary;
    this.notify = notify;
    this.tasks = new Map();
    this.selectedTaskId = "";
    this.pollTimer = null;
    this.modeVersion = 0;
    this.ui = {
      taskList: document.getElementById("taskList"),
      taskCount: document.getElementById("taskCount"),
      downloadAllTasksBtn: document.getElementById("downloadAllTasksBtn"),
      clearStoppedTasksBtn: document.getElementById("clearStoppedTasksBtn"),
      resultStage: document.getElementById("resultStage"),
      emptyState: document.getElementById("emptyState"),
      emptyTitle: document.querySelector("#emptyState strong"),
      emptyDetail: document.querySelector("#emptyState span:last-child"),
      resultVideo: document.getElementById("resultVideo"),
      resultImage: document.getElementById("resultImage"),
      imageViewer: document.getElementById("imageViewer"),
      imageViewerImage: document.getElementById("imageViewerImage"),
      imageViewerClose: document.getElementById("imageViewerClose"),
      resultTitle: document.getElementById("resultTitle"),
      statusBadge: document.getElementById("statusBadge"),
      downloadBtn: document.getElementById("downloadBtn"),
      progressPanel: document.getElementById("progressPanel"),
      progressLabel: document.getElementById("progressLabel"),
      progressBar: document.getElementById("progressBar"),
      progressDetail: document.getElementById("progressDetail"),
      elapsedTime: document.getElementById("elapsedTime"),
    };
    this.setMode(mediaType, false);
    this.ui.downloadAllTasksBtn?.addEventListener("click", () => this.downloadAll());
    this.ui.clearStoppedTasksBtn?.addEventListener("click", () => this.clearStopped());
    this.ui.resultImage.addEventListener("dblclick", () => this.openImageViewer());
    this.ui.resultImage.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openImageViewer();
    });
    this.ui.imageViewerClose.addEventListener("click", () => this.closeImageViewer());
    this.ui.imageViewer.addEventListener("click", (event) => {
      if (event.target === this.ui.imageViewer) this.closeImageViewer();
    });
    this.ui.imageViewer.addEventListener("close", () => {
      this.ui.imageViewerImage.removeAttribute("src");
    });
  }

  setMode(mediaType, refresh = true) {
    this.stop();
    this.mediaType = mediaType === "image" ? "image" : "video";
    this.basePath = this.mediaType === "image" ? "/v1/images/tasks" : "/v1/videos";
    this.ui.resultStage.classList.toggle("image-stage", this.mediaType === "image");
    this.modeVersion += 1;
    this.tasks.clear();
    this.showIdle();
    this.render();
    if (refresh) this.refresh();
  }

  hasSelection() { return Boolean(this.selectedTaskId); }

  setDraftRatio(ratio) {
    if (!this.hasSelection()) this.ui.resultStage.classList.toggle("portrait-stage", ratio === "9:16");
  }

  add(task) {
    this.tasks.set(String(task.id), task);
    this.select(task.id);
  }

  orderedTasks() {
    return Array.from(this.tasks.values()).sort(
      (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0),
    );
  }

  start() { this.refresh(); }

  stop() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  setStatus(status, label) {
    this.ui.statusBadge.className = `status-badge ${status}`;
    this.ui.statusBadge.textContent = label;
  }

  setProgress(value, label, detail, indeterminate = false) {
    this.ui.progressPanel.hidden = false;
    this.ui.progressLabel.textContent = label;
    this.ui.progressDetail.textContent = detail;
    this.ui.progressBar.classList.toggle("indeterminate", indeterminate);
    if (indeterminate) this.ui.progressBar.style.removeProperty("width");
    else this.ui.progressBar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  }

  elapsedLabel(task) {
    const started = Number(task?.started_at || task?.created_at || Date.now() / 1000) * 1000;
    const ended = Number(task?.completed_at || Date.now() / 1000) * 1000;
    const seconds = Math.max(0, Math.floor((ended - started) / 1000));
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
  }

  statusLabel(task) {
    if (task.status === "queued") return task.queue_position ? `排队第 ${task.queue_position} 位` : "排队中";
    return { running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[task.status] || task.status;
  }

  statusClass(status) {
    return { succeeded: "success", queued: "queued", running: "running" }[status] || "failed";
  }

  normalizeUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.origin);
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        return `${window.location.origin}${url.pathname}${url.search}`;
      }
      return url.href;
    } catch (_) {
      return String(value || "");
    }
  }

  resetMedia() {
    this.ui.downloadBtn.hidden = true;
    this.ui.resultImage.hidden = true;
    this.ui.resultImage.removeAttribute("src");
    this.ui.resultVideo.pause();
    this.ui.resultVideo.hidden = true;
    this.ui.resultVideo.removeAttribute("src");
  }

  openImageViewer() {
    const src = this.ui.resultImage.getAttribute("src");
    if (!src || this.ui.imageViewer.open) return;
    this.ui.imageViewerImage.src = src;
    this.ui.imageViewer.showModal();
  }

  closeImageViewer() {
    if (this.ui.imageViewer.open) this.ui.imageViewer.close();
  }

  show(task) {
    if (!task) return;
    const resultUrl = this.normalizeUrl(task.result_url);
    const mediaLabel = this.mediaType === "image" ? "图片" : "视频";
    const resultMedia = this.mediaType === "image" ? this.ui.resultImage : this.ui.resultVideo;
    const preserveResultMedia = (
      task.status === "succeeded"
      && Boolean(resultUrl)
      && resultMedia.getAttribute("src") === resultUrl
    );
    this.ui.resultTitle.textContent = this.modelSummary(task.model);
    this.ui.resultStage.classList.toggle("portrait-stage", /-9x16(?:-|$)/.test(String(task.model || "")));
    this.ui.elapsedTime.textContent = this.elapsedLabel(task);
    this.setStatus(this.statusClass(task.status), this.statusLabel(task));
    if (!preserveResultMedia) this.resetMedia();
    this.ui.emptyState.hidden = false;

    if (task.status === "succeeded" && resultUrl) {
      this.setProgress(100, "生成完成", `${mediaLabel}已保存到服务器`);
      this.ui.emptyState.hidden = true;
      if (this.mediaType === "image") {
        if (!preserveResultMedia) this.ui.resultImage.src = resultUrl;
        this.ui.resultImage.hidden = false;
      } else {
        if (!preserveResultMedia) {
          this.ui.resultVideo.src = resultUrl;
          this.ui.resultVideo.load();
        }
        this.ui.resultVideo.hidden = false;
      }
      this.ui.downloadBtn.href = resultUrl;
      this.ui.downloadBtn.hidden = false;
      return;
    }
    if (task.status === "running") {
      this.ui.emptyTitle.textContent = "正在生成";
      this.ui.emptyDetail.textContent = task.account_name ? `账号：${task.account_name}` : "已分配生成账号";
      this.setProgress(task.progress || 5, "正在生成", this.ui.emptyDetail.textContent, true);
      return;
    }
    if (task.status === "queued") {
      this.ui.emptyTitle.textContent = "等待空闲账号";
      this.ui.emptyDetail.textContent = this.statusLabel(task);
      this.setProgress(0, "排队中", this.ui.emptyDetail.textContent, true);
      return;
    }
    const message = task.error || (task.status === "cancelled" ? "任务已取消" : `${mediaLabel}生成失败`);
    this.ui.emptyTitle.textContent = task.status === "cancelled" ? "任务已取消" : "生成失败";
    this.ui.emptyDetail.textContent = message;
    this.setProgress(0, this.ui.emptyTitle.textContent, message);
  }

  showIdle() {
    this.selectedTaskId = "";
    const mediaLabel = this.mediaType === "image" ? "图片" : "视频";
    this.ui.resultTitle.textContent = `新${mediaLabel}`;
    this.setStatus("idle", "待生成");
    this.ui.downloadBtn.removeAttribute("href");
    this.resetMedia();
    this.ui.emptyState.hidden = false;
    this.ui.emptyTitle.textContent = "准备生成";
    this.ui.emptyDetail.textContent = "设置参数并提交提示词";
    this.ui.progressPanel.hidden = true;
    this.ui.progressBar.classList.remove("indeterminate");
    this.ui.progressBar.style.removeProperty("width");
    this.ui.elapsedTime.textContent = "00:00";
  }

  select(taskId) {
    this.selectedTaskId = String(taskId || "");
    this.render();
    this.show(this.tasks.get(this.selectedTaskId));
  }

  async cancel(taskId) {
    const task = await this.request(`${this.basePath}/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    this.tasks.set(task.id, task);
    this.render();
    if (this.selectedTaskId === task.id) this.show(task);
  }

  async clearStopped() {
    if (this.ui.clearStoppedTasksBtn?.disabled) return;
    this.ui.clearStoppedTasksBtn.disabled = true;
    try {
      const result = await this.request(this.basePath, { method: "DELETE" });
      const deletedIds = new Set((result.deleted_ids || []).map(String));
      deletedIds.forEach((taskId) => this.tasks.delete(taskId));
      if (!this.tasks.has(this.selectedTaskId)) this.selectedTaskId = String(this.orderedTasks()[0]?.id || "");
      if (this.selectedTaskId) this.show(this.tasks.get(this.selectedTaskId));
      else this.showIdle();
      this.notify(`已清理 ${Number(result.deleted_count || 0)} 个任务`);
    } catch (error) {
      this.notify(error.message || "清理失败", true);
    } finally {
      this.render();
    }
  }

  downloadAll() {
    if (this.ui.downloadAllTasksBtn?.disabled) return;
    const type = this.mediaType === "image" ? "images" : "videos";
    window.location.assign(`/api/v1/studio/${type}/archive`);
  }

  render() {
    const tasks = this.orderedTasks();
    const running = tasks.filter((task) => task.status === "running").length;
    const queued = tasks.filter((task) => task.status === "queued").length;
    const stopped = tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).length;
    const completed = tasks.filter((task) => task.status === "succeeded" && task.result_url).length;
    this.ui.taskCount.textContent = `${tasks.length} 个任务${running ? ` · ${running} 生成中` : ""}${queued ? ` · ${queued} 排队` : ""}`;
    if (this.ui.downloadAllTasksBtn) this.ui.downloadAllTasksBtn.disabled = completed === 0;
    if (this.ui.clearStoppedTasksBtn) this.ui.clearStoppedTasksBtn.disabled = stopped === 0;
    this.ui.taskList.innerHTML = "";
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "task-empty";
      empty.textContent = "提交后可继续添加任务";
      this.ui.taskList.appendChild(empty);
      return;
    }

    tasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = `task-item${task.id === this.selectedTaskId ? " active" : ""}`;
      row.addEventListener("click", () => this.select(task.id));
      const status = document.createElement("span");
      status.className = `task-state ${task.status}`;
      status.textContent = this.statusLabel(task);
      const info = document.createElement("div");
      info.className = "task-info";
      const model = document.createElement("strong");
      model.textContent = this.modelSummary(task.model);
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
          try { await this.cancel(task.id); }
          catch (error) { this.notify(error.message || "取消失败", true); }
        });
        actions.appendChild(cancel);
      }
      row.append(status, info, actions);
      this.ui.taskList.appendChild(row);
    });
  }

  async refresh() {
    this.stop();
    const version = this.modeVersion;
    try {
      const body = await this.request(`${this.basePath}?limit=100`);
      if (version !== this.modeVersion) return;
      const tasks = Array.isArray(body.data) ? body.data : [];
      this.tasks = new Map(tasks.map((task) => [String(task.id), task]));
      if (!this.selectedTaskId || !this.tasks.has(this.selectedTaskId)) this.selectedTaskId = String(tasks[0]?.id || "");
      this.render();
      if (this.selectedTaskId) this.show(this.tasks.get(this.selectedTaskId));
      else this.showIdle();
    } catch (error) {
      if (version === this.modeVersion) this.notify(error.message || "任务状态读取失败", true);
    } finally {
      if (version === this.modeVersion) this.pollTimer = setTimeout(() => this.refresh(), 2500);
    }
  }
}
