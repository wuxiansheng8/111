const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class VideoTaskBoard {
  constructor({ request, modelSummary, notify }) {
    this.request = request;
    this.modelSummary = modelSummary;
    this.notify = notify;
    this.tasks = new Map();
    this.selectedTaskId = "";
    this.pollTimer = null;
    this.ui = {
      taskList: document.getElementById("taskList"),
      taskCount: document.getElementById("taskCount"),
      clearStoppedTasksBtn: document.getElementById("clearStoppedTasksBtn"),
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
    };
    this.ui.clearStoppedTasksBtn?.addEventListener("click", () => this.clearStopped());
  }

  hasSelection() {
    return Boolean(this.selectedTaskId);
  }

  setDraftRatio(ratio) {
    if (!this.hasSelection()) {
      this.ui.resultStage.classList.toggle("portrait-stage", ratio === "9:16");
    }
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

  start() {
    this.refresh();
  }

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
    const remainder = (seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  statusLabel(task) {
    if (task.status === "queued") return task.queue_position ? `排队第 ${task.queue_position} 位` : "排队中";
    return {
      running: "生成中",
      succeeded: "已完成",
      failed: "失败",
      cancelled: "已取消",
    }[task.status] || task.status;
  }

  statusClass(status) {
    return { succeeded: "success", queued: "queued", running: "running" }[status] || "failed";
  }

  normalizeVideoUrl(value) {
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

  show(task) {
    if (!task) return;
    const videoUrl = this.normalizeVideoUrl(task.result_url);
    this.ui.resultTitle.textContent = this.modelSummary(task.model);
    this.ui.resultStage.classList.toggle("portrait-stage", String(task.model || "").endsWith("-9x16"));
    this.ui.elapsedTime.textContent = this.elapsedLabel(task);
    this.setStatus(this.statusClass(task.status), this.statusLabel(task));
    this.ui.downloadBtn.hidden = true;
    this.ui.resultVideo.hidden = true;
    this.ui.resultVideo.removeAttribute("src");
    this.ui.emptyState.hidden = false;

    if (task.status === "succeeded" && videoUrl) {
      this.setProgress(100, "生成完成", "视频已保存到服务器");
      this.ui.emptyState.hidden = true;
      this.ui.resultVideo.src = videoUrl;
      this.ui.resultVideo.hidden = false;
      this.ui.downloadBtn.href = videoUrl;
      this.ui.downloadBtn.hidden = false;
      this.ui.resultVideo.load();
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
    const message = task.error || (task.status === "cancelled" ? "任务已取消" : "视频生成失败");
    this.ui.emptyTitle.textContent = task.status === "cancelled" ? "任务已取消" : "生成失败";
    this.ui.emptyDetail.textContent = message;
    this.setProgress(0, this.ui.emptyTitle.textContent, message);
  }

  showIdle() {
    this.selectedTaskId = "";
    this.ui.resultTitle.textContent = "新视频";
    this.setStatus("idle", "待生成");
    this.ui.downloadBtn.hidden = true;
    this.ui.downloadBtn.removeAttribute("href");
    this.ui.resultVideo.pause();
    this.ui.resultVideo.hidden = true;
    this.ui.resultVideo.removeAttribute("src");
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
    const task = await this.request(`/v1/videos/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    this.tasks.set(task.id, task);
    this.render();
    if (this.selectedTaskId === task.id) this.show(task);
  }

  async clearStopped() {
    if (this.ui.clearStoppedTasksBtn?.disabled) return;
    this.ui.clearStoppedTasksBtn.disabled = true;
    try {
      const result = await this.request("/v1/videos", { method: "DELETE" });
      const deletedIds = new Set(
        (Array.isArray(result.deleted_ids) ? result.deleted_ids : []).map(String),
      );
      deletedIds.forEach((taskId) => this.tasks.delete(taskId));

      if (!this.tasks.has(this.selectedTaskId)) {
        this.selectedTaskId = String(this.orderedTasks()[0]?.id || "");
      }
      if (this.selectedTaskId) this.show(this.tasks.get(this.selectedTaskId));
      else this.showIdle();

      this.notify(`已清理 ${Number(result.deleted_count || 0)} 个任务`);
    } catch (error) {
      this.notify(error.message || "清理失败", true);
    } finally {
      this.render();
    }
  }

  render() {
    const tasks = this.orderedTasks();
    const running = tasks.filter((task) => task.status === "running").length;
    const queued = tasks.filter((task) => task.status === "queued").length;
    const stopped = tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).length;
    this.ui.taskCount.textContent = `${tasks.length} 个任务${running ? ` · ${running} 生成中` : ""}${queued ? ` · ${queued} 排队` : ""}`;
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
          try {
            await this.cancel(task.id);
          } catch (error) {
            this.notify(error.message || "取消失败", true);
          }
        });
        actions.appendChild(cancel);
      }
      row.append(status, info, actions);
      this.ui.taskList.appendChild(row);
    });
  }

  async refresh() {
    this.stop();
    try {
      const body = await this.request("/v1/videos?limit=100");
      const tasks = Array.isArray(body.data) ? body.data : [];
      this.tasks = new Map(tasks.map((task) => [String(task.id), task]));
      if (!this.selectedTaskId || !this.tasks.has(this.selectedTaskId)) {
        this.selectedTaskId = String(tasks[0]?.id || "");
      }
      this.render();
      if (this.selectedTaskId) this.show(this.tasks.get(this.selectedTaskId));
      else this.showIdle();
    } catch (error) {
      this.notify(error.message || "任务状态读取失败", true);
    } finally {
      this.pollTimer = setTimeout(() => this.refresh(), 2500);
    }
  }
}
