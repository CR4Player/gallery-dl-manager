const LOG_WINDOW_MAX = 400;

const state = {
  view: "dashboard",
  tasks: [],
  taskBatchMode: false,
  selectedTaskIds: new Set(),
  inputFiles: [],
  adhocFileText: "",
  runs: [],
  siteSummaries: [],
  selectedRunId: null,
  selectedRun: null,
  selectedRunFiles: [],
  selectedRunFileSet: new Set(),
  runElapsedTimer: null,
  rawLogLines: [],
  logTruncated: false,
  logRenderPending: false,
  filesRenderPending: false,
  alerts: [],
  unreadAlertsCount: 0,
  eventSource: null,
  pollTimer: null,
  lastToastTimer: null,
};

const HAS_NATIVE_SWITCH = "switch" in HTMLInputElement.prototype;

function initStaticSwitches() {
  if (HAS_NATIVE_SWITCH) return;
  document.querySelectorAll('input[type="checkbox"][switch]').forEach((el) => {
    el.classList.add("switch-fallback");
  });
}

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtRelativeFuture(iso) {
  if (!iso) return "";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMin = Math.round((target - Date.now()) / 60000);
  if (diffMin <= 0) return "即将执行";
  if (diffMin < 60) return `${diffMin} 分钟后`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h < 24) return m > 0 ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d} 天 ${rh} 小时后` : `${d} 天后`;
}

function renderAlertsBadge() {
  const badge = document.getElementById("alerts-unread-badge");
  if (!badge) return;
  const cnt = Number(state.unreadAlertsCount || 0);
  if (cnt <= 0) {
    badge.classList.add("hidden");
    badge.textContent = "0";
  } else {
    badge.textContent = cnt > 99 ? "99+" : String(cnt);
    badge.classList.remove("hidden");
  }
}

function renderAlertsPopover() {
  renderAlertsBadge();
  const listEl = document.getElementById("alerts-pop-list");
  const countEl = document.getElementById("alerts-pop-count");
  if (countEl) {
    countEl.textContent = state.alerts.length ? `(未读 ${state.unreadAlertsCount} / 共 ${state.alerts.length})` : "";
  }
  if (!listEl) return;
  if (!state.alerts.length) {
    listEl.innerHTML = `<div class="muted sm" style="padding:1rem; text-align:center;">暂无异常告警或失败通知。</div>`;
    return;
  }
  listEl.innerHTML = state.alerts
    .map(
      (a) => `
    <div class="alert-row ${a.read ? "" : "unread"}">
      <button type="button" class="alert-row-main" data-alert-jump="${esc(a.alert_key)}" data-alert-run="${a.run_id ?? ""}" data-alert-view="${esc(a.target_view)}">
        <div class="run-item-top">${statusBadge(a.status, "status-pill")} <strong>${esc(a.title)}</strong></div>
        <div class="alert-detail">${esc(a.detail)}</div>
        <div class="muted sm">${fmtTime(a.created_at)}</div>
      </button>
      <div class="alert-row-actions">
        ${!a.read ? `<button type="button" class="btn ghost sm" data-alert-read="${esc(a.alert_key)}" title="标为已读">已读</button>` : ""}
        <button type="button" class="btn ghost sm" data-alert-clear="${esc(a.alert_key)}" aria-label="清除此条通知" title="清除">✕</button>
      </div>
    </div>`
    )
    .join("");
}

async function loadAlerts() {
  try {
    const data = await api("/api/alerts");
    state.alerts = data.items || [];
    state.unreadAlertsCount = Number(data.unread_count || 0);
    renderAlertsPopover();
  } catch {}
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(state.lastToastTimer);
  state.lastToastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

async function api(url, opts = {}) {
  const headers = { "X-Requested-With": "fetch", ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== "string") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    location.replace("/login");
    throw new Error("未登录");
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

function statusBadge(status, extraClass = "") {
  const labels = {
    queued: "排队中",
    running: "运行中",
    success: "成功",
    partial: "部分失败",
    auth_error: "认证失效",
    failed: "失败",
    cancelled: "已中止",
  };
  const cls = extraClass ? `badge ${esc(status)} ${esc(extraClass)}` : `badge ${esc(status)}`;
  return `<span class="${cls}">${esc(labels[status] || status)}</span>`;
}

// Backdrop click dismiss only when pointerdown AND click both occur outside dialog content
// (prevents closing when selecting text inside an input/textarea and releasing outside).
function initDialogs() {
  const isOutsideDialog = (dlg, x, y) => {
    const rect = dlg.getBoundingClientRect();
    return !(
      rect.top <= y &&
      y <= rect.top + rect.height &&
      rect.left <= x &&
      x <= rect.left + rect.width
    );
  };

  document.querySelectorAll("dialog").forEach((dlg) => {
    let pointerDownOnBackdrop = false;
    dlg.addEventListener("pointerdown", (event) => {
      pointerDownOnBackdrop =
        event.target === dlg && isOutsideDialog(dlg, event.clientX, event.clientY);
    });
    dlg.addEventListener("click", (event) => {
      const shouldClose =
        pointerDownOnBackdrop &&
        event.target === dlg &&
        isOutsideDialog(dlg, event.clientX, event.clientY);
      pointerDownOnBackdrop = false;
      if (shouldClose) dlg.close();
    });
    dlg.addEventListener("close", () => {
      pointerDownOnBackdrop = false;
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.closeDialog)?.close();
    });
  });
}

// Theme management (light dark / light / dark)
function initThemeControl() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const sysHint = document.getElementById("sys-scheme-hint");
  const mq = window.matchMedia("(prefers-color-scheme: dark)");

  const refreshButtons = () => {
    let saved = null;
    try { saved = localStorage.getItem("color-scheme"); } catch {}
    const choice = saved === "light" || saved === "dark" ? saved : "system";
    meta.content = choice === "system" ? "light dark" : choice;
    sysHint.textContent = mq.matches ? "当前深色" : "当前浅色";
    document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.themeChoice === choice ? "true" : "false");
    });
  };

  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.themeChoice;
      try {
        if (val === "system") localStorage.removeItem("color-scheme");
        else localStorage.setItem("color-scheme", val);
      } catch {}
      refreshButtons();
    });
  });

  mq.addEventListener("change", refreshButtons);
  window.addEventListener("storage", (e) => {
    if (e.key === "color-scheme") refreshButtons();
  });
  refreshButtons();
}

function switchView(name) {
  state.view = name;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "dashboard") loadDashboard();
  else if (name === "tasks") loadTasks();
  else if (name === "runs") loadRuns();
  else if (name === "config") loadConfigOverview();
  else if (name === "notifications") loadNotifications();
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  const v = data.versions || {};
  document.getElementById("version-line").textContent =
    `gallery-dl ${v.gallery_dl || "?"} · exiftool ${v.exiftool || "?"}`;

  const pill = document.getElementById("scheduler-pill");
  pill.textContent = data.scheduler_paused ? "调度已暂停" : "调度运行中";
  pill.classList.toggle("paused", data.scheduler_paused);
  pill.classList.toggle("running", !data.scheduler_paused);
  pill.dataset.paused = data.scheduler_paused ? "1" : "0";

  document.getElementById("legacy-banner").classList.toggle("hidden", !data.legacy_import_notice);
  if (typeof data.unread_alerts_count === "number") {
    state.unreadAlertsCount = data.unread_alerts_count;
    renderAlertsBadge();
  }

  const s = data.stats;
  document.getElementById("stat-active").textContent = `${s.running_count} / ${s.queued_count}`;
  document.getElementById("stat-today").textContent = s.today_downloaded;
  document.getElementById("stat-week").textContent = s.week_downloaded;
  document.getElementById("stat-tasks").textContent = `${s.task_enabled} / ${s.task_total}`;

  const activeBox = document.getElementById("active-runs-box");
  if (!data.active_runs.length) {
    activeBox.innerHTML = `<div class="notice sm">当前空闲 · 队列无等待或运行中任务</div>`;
  } else {
    activeBox.innerHTML = data.active_runs
      .map(
        (r) => `
      <div class="notice info banner-row">
        <div>
          <div class="run-item-top">${statusBadge(r.status, "status-pill")} <strong>#${r.id} ${esc(r.task_name)}</strong></div>
          <div class="muted sm">+${r.downloaded_count} 新增 · ${r.skipped_count} 跳过 · 耗时 ${r.duration_sec != null ? `${Math.round(r.duration_sec)}s` : "-"}</div>
        </div>
        <div class="row-actions">
          <button type="button" class="btn ghost sm" data-inspect-run="${r.id}">实时日志</button>
          <button type="button" class="btn danger sm" data-cancel-run="${r.id}">中止</button>
        </div>
      </div>`
      )
      .join("");
  }

  const upcomingBox = document.getElementById("upcoming-tasks-box");
  const upcoming = data.upcoming_tasks || [];
  if (data.scheduler_paused) {
    upcomingBox.innerHTML = `<div class="notice warn banner-row"><span class="sm">全局定时调度当前已暂停，可在右上角胶囊恢复。</span><button type="button" class="btn ghost sm" data-goto="tasks">管理任务</button></div>`;
  } else if (!upcoming.length) {
    upcomingBox.innerHTML = `<div class="notice banner-row"><span class="muted sm">暂无已启用的定时任务。</span><button type="button" class="btn ghost sm" data-goto="tasks">前往配置</button></div>`;
  } else {
    upcomingBox.innerHTML = upcoming
      .map(
        (t) => `
      <div class="upcoming-item">
        <div>
          <div class="row-actions"><strong>${esc(t.name)}</strong> <span class="badge">${esc(fmtRelativeFuture(t.next_run_at))}</span></div>
          <div class="muted sm">${fmtTime(t.next_run_at)} · ${esc(t.cron_desc)}</div>
        </div>
        <button type="button" class="btn ghost sm" data-run-task="${t.id}">立即执行</button>
      </div>`
      )
      .join("");
  }

  const storageBox = document.getElementById("storage-summary-box");
  const st = data.storage_summary || {};
  storageBox.innerHTML = `
    <button type="button" class="mini-stat" data-goto="config">
      <span class="muted sm">Archive 去重库</span>
      <strong>${st.archive_entries ?? 0} 条</strong>
    </button>
    <button type="button" class="mini-stat" data-goto="config">
      <span class="muted sm">Twitter 红心 ID</span>
      <strong>${st.twitter_sync_ids ?? 0} 条</strong>
    </button>
    <button type="button" class="mini-stat" data-goto="tasks">
      <span class="muted sm">NAS 输入列表</span>
      <strong>${st.input_files_count ?? 0} 个</strong>
    </button>
  `;

  const tbody = document.getElementById("dash-runs-tbody");
  tbody.innerHTML = data.recent_runs
    .map(
      (r) => `
    <tr>
      <td data-label="ID">#${r.id}</td>
      <td data-label="任务">${esc(r.task_name)}${r.simulate ? ' <span class="badge">模拟</span>' : ""}</td>
      <td data-label="触发">${esc(r.trigger_type)}</td>
      <td data-label="状态">${statusBadge(r.status)}</td>
      <td data-label="新增 / 跳过">+${r.downloaded_count} / ${r.skipped_count}</td>
      <td data-label="耗时">${r.duration_sec != null ? `${r.duration_sec}s` : "-"}</td>
      <td data-label="时间">${fmtTime(r.created_at)}</td>
      <td data-label="操作">
        <button type="button" class="btn ghost sm" data-inspect-run="${r.id}">日志</button>
      </td>
    </tr>`
    )
    .join("");
}

function syncTaskBatchUI() {
  const bar = document.getElementById("tasks-batch-bar");
  const th = document.getElementById("tasks-batch-th");
  const toggleBtn = document.getElementById("tasks-batch-toggle-btn");
  bar.classList.toggle("hidden", !state.taskBatchMode);
  th.classList.toggle("hidden", !state.taskBatchMode);
  toggleBtn.textContent = state.taskBatchMode ? "完成批量管理" : "批量管理";

  const visibleIds = state.tasks.map((t) => t.id);
  const selectedVisible = visibleIds.filter((id) => state.selectedTaskIds.has(id)).length;
  const selectAll = document.getElementById("tasks-select-all");
  selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;

  document.getElementById("tasks-batch-count").textContent = `已选 ${state.selectedTaskIds.size} 项`;
  document.querySelectorAll("[data-batch-action]").forEach((b) => {
    b.disabled = state.selectedTaskIds.size === 0;
  });
}

function renderTasksTable() {
  const tbody = document.getElementById("tasks-tbody");
  const validIds = new Set(state.tasks.map((t) => t.id));
  for (const id of [...state.selectedTaskIds]) {
    if (!validIds.has(id)) state.selectedTaskIds.delete(id);
  }
  syncTaskBatchUI();

  if (!state.tasks.length) {
    tbody.innerHTML = `<tr><td colspan="${state.taskBatchMode ? 6 : 5}" class="muted">暂无定时任务，点击右上角「新建任务」。</td></tr>`;
    return;
  }
  const swClass = HAS_NATIVE_SWITCH ? "task-switch" : "task-switch switch-fallback";
  tbody.innerHTML = state.tasks
    .map(
      (t) => `
    <tr>
      <td class="batch-col ${state.taskBatchMode ? "" : "hidden"}" data-label="选择">
        <input type="checkbox" class="checkbox-custom task-select-cb" data-select-task="${t.id}" ${state.selectedTaskIds.has(t.id) ? "checked" : ""} aria-label="选择任务 ${esc(t.name)}">
      </td>
      <td data-label="任务名称">
        <strong>${esc(t.name)}</strong>
        <div class="muted sm">${t.input_file ? `输入文件：<code>${esc(t.input_file)}</code>` : esc((t.urls || []).join(" · "))}</div>
      </td>
      <td data-label="启用状态">
        <label class="switch-wrap">
          <input type="checkbox" switch role="switch" class="${swClass}" data-toggle-task="${t.id}" ${t.enabled ? "checked" : ""} aria-label="启用定时任务 ${esc(t.name)}">
          <span class="sm ${t.enabled ? "" : "muted"}">${t.enabled ? "已启用" : "已停用"}</span>
        </label>
        ${t.consecutive_failures > 0 ? `<div class="sm" style="color:var(--danger)">连续异常 ${t.consecutive_failures} 次</div>` : ""}
      </td>
      <td data-label="调度计划">
        <code>${esc(t.cron_expr)}</code>
        <div class="muted sm">${esc(t.cron_desc)}</div>
        ${t.next_runs?.length ? `<div class="muted sm">下次：${fmtTime(t.next_runs[0])}</div>` : ""}
      </td>
      <td data-label="最近执行">
        ${t.last_status ? statusBadge(t.last_status) : '<span class="muted sm">尚未运行</span>'}
        <div class="muted sm">${fmtTime(t.last_run_at)}</div>
      </td>
      <td data-label="操作">
        <div class="row-actions">
          <button type="button" class="btn primary sm" data-run-task="${t.id}">立即执行</button>
          <button type="button" class="btn ghost sm icon-btn" popovertarget="task-menu-${t.id}" style="anchor-name: --tm-${t.id}" aria-label="更多操作 (${esc(t.name)})">⋯</button>
          <div id="task-menu-${t.id}" popover="auto" class="action-popover" style="position-anchor: --tm-${t.id}">
            <button type="button" class="popover-item" data-sim-task="${t.id}">模拟试跑</button>
            <button type="button" class="popover-item" data-edit-task="${t.id}">编辑任务</button>
            <button type="button" class="popover-item danger" data-delete-task="${t.id}">删除任务</button>
          </div>
        </div>
      </td>
    </tr>`
    )
    .join("");
}

async function loadTasks() {
  const data = await api("/api/tasks");
  state.tasks = data.tasks;
  renderTasksTable();
}

function formatPreviewText(res) {
  if (!res) return "";
  const lines = [`exec: ${res.exec_command || ""}`];
  if (res.exiftool_image_cmd) lines.push(`图片: ${res.exiftool_image_cmd}`);
  if (res.exiftool_video_cmd) lines.push(`视频: ${res.exiftool_video_cmd}`);
  return lines.join("\n");
}

async function ensureSiteSummaries() {
  if (state.siteSummaries.length) return state.siteSummaries;
  try {
    const data = await api("/api/config/overview");
    state.siteSummaries = data.sites || [];
  } catch {}
  return state.siteSummaries;
}

async function refreshTaskPostprocessUI() {
  const mode = document.getElementById("tf-pp-mode").value;
  document.getElementById("tf-pp-date-wrap").classList.toggle("hidden", mode !== "enabled");
  document.getElementById("tf-pp-cmd-wrap").classList.toggle("hidden", mode !== "custom");
  const out = document.getElementById("tf-pp-preview");

  if (mode === "disabled") {
    out.textContent = "(已禁用后处理，不执行 exiftool 与 mtime 同步)";
    return;
  }
  if (mode === "inherit") {
    const sites = await ensureSiteSummaries();
    const enabled = sites.filter((s) => s.postprocess_enabled);
    if (!enabled.length) {
      out.textContent = "(当前没有任何站点开启默认后处理；可在「配置与凭据」按站点开启)";
      return;
    }
    out.textContent = enabled
      .map((s) => `[${s.site}] ${s.postprocess_preview?.exec_command || ""}`)
      .join("\n");
    return;
  }
  try {
    const res = await api("/api/config/postprocess-preview", {
      method: "POST",
      body: {
        mode: mode === "custom" ? "custom" : "builtin",
        date_template: document.getElementById("tf-pp-date").value.trim(),
        custom_command: document.getElementById("tf-pp-cmd").value.trim(),
      },
    });
    out.textContent = formatPreviewText(res);
  } catch (err) {
    out.textContent = err.message;
  }
}

async function refreshAdhocPostprocessUI() {
  const mode = document.getElementById("adhoc-pp-mode").value;
  const panel = document.getElementById("adhoc-pp-panel");
  panel.classList.toggle("hidden", mode === "inherit" || mode === "disabled");
  document.getElementById("adhoc-pp-date-wrap").classList.toggle("hidden", mode !== "enabled");
  document.getElementById("adhoc-pp-cmd-wrap").classList.toggle("hidden", mode !== "custom");
  if (mode === "inherit" || mode === "disabled") return;
  try {
    const res = await api("/api/config/postprocess-preview", {
      method: "POST",
      body: {
        mode: mode === "custom" ? "custom" : "builtin",
        date_template: document.getElementById("adhoc-pp-date").value.trim(),
        custom_command: document.getElementById("adhoc-pp-cmd").value.trim(),
      },
    });
    document.getElementById("adhoc-pp-preview").textContent = formatPreviewText(res);
  } catch (err) {
    document.getElementById("adhoc-pp-preview").textContent = err.message;
  }
}

async function refreshSitePostprocessUI() {
  const enabled = document.getElementById("sf-pp").checked;
  document.getElementById("sf-pp-panel").classList.toggle("hidden", !enabled);
  if (!enabled) return;
  const ptype = document.getElementById("sf-pp-type").value;
  document.getElementById("sf-pp-date-wrap").classList.toggle("hidden", ptype !== "builtin");
  document.getElementById("sf-pp-extra-wrap").classList.toggle("hidden", ptype !== "builtin");
  document.getElementById("sf-pp-cmd-wrap").classList.toggle("hidden", ptype !== "custom");
  try {
    const res = await api("/api/config/postprocess-preview", {
      method: "POST",
      body: {
        mode: ptype,
        date_template: document.getElementById("sf-pp-date").value.trim(),
        extra_args: document.getElementById("sf-pp-extra").value.trim(),
        custom_command: document.getElementById("sf-pp-cmd").value.trim(),
      },
    });
    document.getElementById("sf-pp-preview").textContent = formatPreviewText(res);
  } catch (err) {
    document.getElementById("sf-pp-preview").textContent = err.message;
  }
}

function syncTaskSourceMode() {
  const mode = document.getElementById("tf-source-mode").value;
  document.getElementById("tf-urls-wrap").classList.toggle("hidden", mode !== "urls");
  document.getElementById("tf-input-file-wrap").classList.toggle("hidden", mode !== "input_file");
}

async function loadInputFiles(selectedName = "") {
  try {
    const data = await api("/api/inputs");
    state.inputFiles = data.files || [];
  } catch {
    state.inputFiles = [];
  }
  const sel = document.getElementById("tf-input-file");
  const curVal = selectedName || sel.value;
  if (!state.inputFiles.length) {
    sel.innerHTML = `<option value="">(暂无文件，请先上传或放入 /data/inputs/)</option>`;
    return;
  }
  sel.innerHTML = state.inputFiles
    .map((f) => `<option value="${esc(f.name)}">${esc(f.name)} (${f.url_count} 条 URL)</option>`)
    .join("");
  if (curVal && state.inputFiles.some((f) => f.name === curVal)) {
    sel.value = curVal;
  }
}

async function openTaskDialog(task = null) {
  document.getElementById("task-dialog-title").textContent = task ? `编辑任务：${task.name}` : "新建定时任务";
  document.getElementById("tf-id").value = task ? task.id : "";
  document.getElementById("tf-name").value = task ? task.name : "";
  document.getElementById("tf-cron").value = task ? task.cron_expr : "0 */6 * * *";
  const srcMode = task && task.input_file ? "input_file" : "urls";
  document.getElementById("tf-source-mode").value = srcMode;
  syncTaskSourceMode();
  document.getElementById("tf-urls").value = task ? (task.urls || []).join("\n") : "";
  await loadInputFiles(task ? task.input_file || "" : "");
  document.getElementById("tf-proxy-mode").value = task ? task.proxy_mode : "inherit";
  document.getElementById("tf-proxy-url").value = task ? task.proxy_url : "";
  document.getElementById("tf-proxy-url-wrap").style.display =
    (task ? task.proxy_mode : "inherit") === "custom" ? "" : "none";
  document.getElementById("tf-pp-mode").value = task ? task.postprocess_mode : "inherit";
  document.getElementById("tf-pp-date").value = (task && task.postprocess_date_field) || "{date:%Y-%m-%dT%H:%M:%S}";
  document.getElementById("tf-pp-cmd").value = (task && task.postprocess_command) || "";
  document.getElementById("tf-skip").value = task ? task.skip_mode : "";
  document.getElementById("tf-subdir").value = task ? task.subdir : "";
  document.getElementById("tf-extra").value = task ? task.extra_args : "";
  document.getElementById("tf-filename").value = task ? (task.filename_format || "") : "";
  document.getElementById("tf-enabled").checked = task ? task.enabled : true;
  const useArch = task ? Boolean(task.use_archive) : false;
  document.getElementById("tf-archive").checked = useArch;
  const bfEl = document.getElementById("tf-archive-backfill");
  bfEl.disabled = !useArch;
  bfEl.checked = useArch && Boolean(task && task.archive_backfill);
  previewTaskCron();
  refreshTaskPostprocessUI();
  document.getElementById("task-dialog").showModal();
}

async function previewTaskCron() {
  const box = document.getElementById("tf-cron-preview");
  const expr = document.getElementById("tf-cron").value.trim();
  try {
    const res = await api("/api/cron/preview", { method: "POST", body: { cron_expr: expr } });
    box.className = "notice info sm";
    box.innerHTML = `<strong>${esc(res.description)}</strong> · 未来 3 次：${res.next_runs.map(esc).join(" | ")}`;
  } catch (err) {
    box.className = "notice danger sm";
    box.textContent = err.message;
  }
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.runElapsedTimer) {
    clearInterval(state.runElapsedTimer);
    state.runElapsedTimer = null;
  }
  state.logRenderPending = false;
  state.filesRenderPending = false;
}

function scheduleLogRender() {
  if (state.logRenderPending) return;
  state.logRenderPending = true;
  requestAnimationFrame(() => {
    state.logRenderPending = false;
    renderLogLines();
  });
}

function scheduleFilesRender() {
  if (state.filesRenderPending) return;
  state.filesRenderPending = true;
  requestAnimationFrame(() => {
    state.filesRenderPending = false;
    renderRunFiles();
  });
}

function renderRunHeader() {
  const r = state.selectedRun;
  if (!r) return;
  let durText = "-";
  if (r.status === "running" && r.started_at) {
    const startedMs = new Date(r.started_at).getTime();
    if (!Number.isNaN(startedMs)) {
      durText = `${Math.max(0, Math.floor((Date.now() - startedMs) / 1000))}s`;
    } else if (r.duration_sec != null) {
      durText = `${r.duration_sec}s`;
    }
  } else if (r.duration_sec != null) {
    durText = `${r.duration_sec}s`;
  }
  document.getElementById("run-detail-title").innerHTML = `${statusBadge(r.status, "status-pill")} <span>#${r.id} ${esc(r.task_name)}</span>`;
  document.getElementById("run-detail-meta").textContent =
    `触发：${r.trigger_type}${r.simulate ? " (模拟)" : ""} · 新增 ${r.downloaded_count} · 跳过 ${r.skipped_count} · 后处理 ${r.postprocess_ok} 成功 / ${r.postprocess_warn} 警告 · 耗时 ${durText}`;

  const cardSub = document.querySelector(`.run-item[data-select-run="${r.id}"] .muted`);
  if (cardSub) {
    cardSub.textContent = `+${r.downloaded_count} 新增 · ${r.skipped_count} 跳过 · ${fmtTime(r.created_at)}`;
  }
}

function renderRunFiles() {
  const files = state.selectedRunFiles || [];
  document.getElementById("run-files-count").textContent = files.length;
  const fl = document.getElementById("run-files-list");
  fl.innerHTML = files.length
    ? files.map((f) => `<li>${esc(f.file_path)}</li>`).join("")
    : `<li class="muted">本次运行暂无新下载落盘文件。</li>`;
}

function renderLogLines() {
  const viewer = document.getElementById("log-viewer");
  const hint = document.getElementById("log-window-hint");
  if (hint) {
    if (state.logTruncated) {
      hint.textContent = `仅滚动展示最近 ${state.rawLogLines.length} 行日志，完整记录请点击右上角「下载日志」`;
      hint.classList.remove("hidden");
    } else {
      hint.textContent = "";
      hint.classList.add("hidden");
    }
  }
  const query = document.getElementById("log-search").value.trim().toLowerCase();
  const onlyErr = document.getElementById("log-only-errors").checked;

  const filtered = state.rawLogLines.filter((line) => {
    if (query && !line.toLowerCase().includes(query)) return false;
    if (onlyErr && !/\[error\]|\[warning\]|\[warn\]|challengeerror|403|401/i.test(line)) return false;
    return true;
  });
  viewer.textContent = filtered.join("\n");
  if (document.getElementById("log-autoscroll").checked) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}

async function loadRuns(autoSelectId = null) {
  const status = document.getElementById("runs-status-filter").value;
  const qs = new URLSearchParams({ limit: "60" });
  if (status) qs.set("status", status);
  const data = await api(`/api/runs?${qs.toString()}`);
  state.runs = data.runs;
  const box = document.getElementById("runs-list-box");
  if (!state.runs.length) {
    box.innerHTML = `<div class="muted sm">暂无运行记录。</div>`;
    return;
  }
  const targetId = autoSelectId || state.selectedRunId || state.runs[0].id;
  box.innerHTML = state.runs
    .map(
      (r) => `
    <button type="button" class="run-item ${r.id === targetId ? "active" : ""}" data-select-run="${r.id}">
      <div class="run-item-top">
        ${statusBadge(r.status, "status-pill")}
        <strong>#${r.id} ${esc(r.task_name)}</strong>
      </div>
      <div class="muted sm">+${r.downloaded_count} 新增 · ${r.skipped_count} 跳过 · ${fmtTime(r.created_at)}</div>
    </button>`
    )
    .join("");
  if (targetId) {
    await selectRun(targetId);
  }
}

async function selectRun(runId) {
  state.selectedRunId = runId;
  document.querySelectorAll(".run-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.selectRun) === runId);
  });
  closeStream();

  const detail = await api(`/api/runs/${runId}`);
  const r = detail.run;
  state.selectedRun = r;
  state.selectedRunFiles = detail.files || [];
  state.selectedRunFileSet = new Set(state.selectedRunFiles.map((f) => f.file_path));
  renderRunHeader();
  renderRunFiles();

  const acts = document.getElementById("run-detail-actions");
  const isLive = r.status === "queued" || r.status === "running";
  acts.innerHTML = `
    ${isLive ? `<button type="button" class="btn danger sm" data-cancel-run="${r.id}">中止任务</button>` : `<button type="button" class="btn ghost sm" data-retry-run="${r.id}">重试</button>`}
    <a class="btn ghost sm" href="/api/runs/${r.id}/log?download=1">下载日志</a>
  `;

  state.rawLogLines = [];
  state.logTruncated = false;
  renderLogLines();

  if (isLive) {
    state.runElapsedTimer = setInterval(() => {
      if (state.selectedRun && state.selectedRun.status === "running") {
        renderRunHeader();
      }
    }, 1000);
    const es = new EventSource(`/api/runs/${runId}/stream?tail=${LOG_WINDOW_MAX}`);
    state.eventSource = es;
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "log_snapshot") {
          const lines = Array.isArray(msg.lines) ? msg.lines : [];
          state.rawLogLines = lines.slice(-LOG_WINDOW_MAX);
          state.logTruncated = Boolean(msg.truncated) || lines.length > LOG_WINDOW_MAX;
          scheduleLogRender();
        } else if (msg.type === "log") {
          state.rawLogLines.push(msg.line);
          if (state.rawLogLines.length > LOG_WINDOW_MAX) {
            state.rawLogLines = state.rawLogLines.slice(-LOG_WINDOW_MAX);
            state.logTruncated = true;
          }
          scheduleLogRender();
        } else if (msg.type === "stats" && state.selectedRun) {
          state.selectedRun.status = "running";
          state.selectedRun.downloaded_count = msg.downloaded_count;
          state.selectedRun.skipped_count = msg.skipped_count;
          state.selectedRun.postprocess_ok = msg.postprocess_ok;
          state.selectedRun.postprocess_warn = msg.postprocess_warn;
          state.selectedRun.duration_sec = msg.duration_sec;
          renderRunHeader();
        } else if (msg.type === "file") {
          if (!state.selectedRunFileSet.has(msg.file_path)) {
            state.selectedRunFileSet.add(msg.file_path);
            state.selectedRunFiles.push({ file_path: msg.file_path });
            scheduleFilesRender();
          }
        } else if (msg.type === "done") {
          closeStream();
          selectRun(runId);
          loadRuns(runId);
        }
      } catch {}
    };
  } else {
    state.rawLogLines = detail.log_lines || [];
    state.logTruncated = Boolean(detail.log_truncated);
    renderLogLines();
  }
}

async function loadConfigOverview() {
  const data = await api("/api/config/overview");
  state.siteSummaries = data.sites || [];
  const s = data.settings;
  document.getElementById("cfg-global-proxy").value = s.global_proxy || "";
  document.getElementById("cfg-default-skip").value = data.default_skip ?? "";
  document.getElementById("cfg-retries").value = data.downloader?.retries ?? 4;
  document.getElementById("cfg-timeout").value = data.downloader?.timeout ?? 30;
  document.getElementById("cfg-retention").value = s.log_retention_days ?? 30;
  document.getElementById("cfg-concurrency").value = String(s.max_concurrency ?? 1);
  document.getElementById("cfg-pp-sites").value = (s.postprocess_default_sites || []).join(",");

  document.getElementById("sites-tbody").innerHTML = data.sites.length
    ? data.sites
        .map(
          (site) => `
      <tr>
        <td data-label="站点"><strong>${esc(site.site)}</strong></td>
        <td data-label="Cookie 数量">${site.cookie_count} 个 ${site.cookie_keys?.length ? `<span class="muted sm">(${esc(site.cookie_keys.slice(0, 4).join(", "))}${site.cookie_keys.length > 4 ? "…" : ""})</span>` : ""}</td>
        <td data-label="认证字段">${site.auth_fields.map((a) => `<code>${esc(a.key)}=${esc(a.masked)}</code>`).join(" ") || '<span class="muted sm">无</span>'}</td>
        <td data-label="文件命名模板">${site.filename ? `<code>${esc(site.filename)}</code>` : '<span class="muted sm">站点默认</span>'}</td>
        <td data-label="后处理">
          ${site.postprocess_enabled
            ? `<span class="badge success">${site.postprocess_config?.mode === "custom" ? "自定义指令" : "内置 ExifTool"}</span><div class="muted sm"><code>${esc(site.postprocess_config?.mode === "custom" ? (site.postprocess_config?.custom_command || "") : (site.postprocess_config?.date_template || "{date:%Y-%m-%dT%H:%M:%S}"))}</code></div>`
            : '<span class="badge">未开启</span>'}
        </td>
        <td data-label="操作">
          <div class="row-actions">
            <button type="button" class="btn ghost sm" data-edit-site="${esc(site.site)}">编辑 / 粘贴 Cookie</button>
            <button type="button" class="btn danger sm" data-delete-site="${esc(site.site)}">删除</button>
          </div>
        </td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="muted">暂无站点配置。</td></tr>`;

  document.getElementById("snapshots-tbody").innerHTML = data.snapshots
    .map(
      (snap) => `
    <tr>
      <td data-label="ID">#${snap.id}</td>
      <td data-label="时间">${fmtTime(snap.created_at)}</td>
      <td data-label="备注">${esc(snap.note)}</td>
      <td data-label="操作"><button type="button" class="btn ghost sm" data-restore-snap="${snap.id}">回滚至此版本</button></td>
    </tr>`
    )
    .join("");
  await loadTwitterSyncStatus();
}

async function loadTwitterSyncStatus() {
  try {
    const data = await api("/api/twitter-sync/status");
    const tokenEl = document.getElementById("tw-sync-token");
    if (tokenEl) tokenEl.value = data.token || "";
    const s = data.sources || {};
    const statsEl = document.getElementById("tw-sync-stats");
    if (statsEl) {
      statsEl.textContent = `当前已聚合 ${data.count ?? 0} 条推文 ID（SQLite Archive: ${s.archive_sqlite ?? 0} · 本地磁盘扫描: ${s.disk ?? 0} · like.js 导入: ${s.archive_js ?? 0} · 浏览器实时记录: ${s.browser ?? 0}）`;
    }
  } catch (err) {
    const statsEl = document.getElementById("tw-sync-stats");
    if (statsEl) statsEl.textContent = `加载同步状态失败：${err.message}`;
  }
}

async function openSiteDialog(siteName = "") {
  document.getElementById("site-form").reset();
  const siteInput = document.getElementById("sf-site");
  siteInput.value = siteName;
  siteInput.readOnly = Boolean(siteName);
  document.getElementById("sf-cookie-keys").textContent = "无";
  document.getElementById("sf-pp-type").value = "builtin";
  document.getElementById("sf-pp-date").value = "{date:%Y-%m-%dT%H:%M:%S}";
  document.getElementById("sf-pp-extra").value = "";
  document.getElementById("sf-pp-cmd").value = "";

  if (siteName) {
    const data = await api(`/api/config/site/${encodeURIComponent(siteName)}`);
    document.getElementById("sf-username").value = data.username || "";
    document.getElementById("sf-userid").value = data.user_id || "";
    document.getElementById("sf-browser").value = data.browser || "";
    document.getElementById("sf-user-agent").value = data.user_agent || "";
    document.getElementById("sf-filename").value = data.filename || "";
    document.getElementById("sf-skip").value = data.skip || "";
    document.getElementById("sf-pp").checked = Boolean(data.postprocess_enabled);
    const pcfg = data.postprocess_config || {};
    document.getElementById("sf-pp-type").value = pcfg.mode || "builtin";
    document.getElementById("sf-pp-date").value = pcfg.date_template || "{date:%Y-%m-%dT%H:%M:%S}";
    document.getElementById("sf-pp-extra").value = pcfg.extra_args || "";
    document.getElementById("sf-pp-cmd").value = pcfg.custom_command || "";
    document.getElementById("sf-cookie-keys").textContent = data.cookie_keys?.length
      ? `${data.cookie_keys.length} 项 (${data.cookie_keys.join(", ")})`
      : "无";
  }
  await refreshSitePostprocessUI();
  document.getElementById("site-dialog").showModal();
}

async function loadNotifications() {
  const data = await api("/api/notifications");
  const c = data.config;
  document.getElementById("notif-enabled").checked = Boolean(c.enabled);
  document.getElementById("notif-cooldown").value = c.cooldown_minutes ?? 60;
  document.getElementById("notif-recovery").checked = Boolean(c.notify_on_recovery);
  document.getElementById("notif-use-proxy").checked = Boolean(c.use_proxy);
  const events = new Set(c.notify_on || []);
  document.querySelectorAll(".notif-event").forEach((cb) => {
    cb.checked = events.has(cb.value);
  });

  document.getElementById("tg-enabled").checked = Boolean(c.telegram?.enabled);
  document.getElementById("tg-token").value = c.telegram?.bot_token || "";
  document.getElementById("tg-chat").value = c.telegram?.chat_id || "";
  document.getElementById("tg-base").value = c.telegram?.api_base || "https://api.telegram.org";

  document.getElementById("fs-enabled").checked = Boolean(c.feishu?.enabled);
  document.getElementById("fs-url").value = c.feishu?.webhook_url || "";
  document.getElementById("fs-secret").value = c.feishu?.secret || "";

  document.getElementById("bk-enabled").checked = Boolean(c.bark?.enabled);
  document.getElementById("bk-server").value = c.bark?.server_url || "https://api.day.app";
  document.getElementById("bk-key").value = c.bark?.device_key || "";
  document.getElementById("bk-group").value = c.bark?.group || "gallery-dl";

  document.getElementById("wh-enabled").checked = Boolean(c.webhook?.enabled);
  document.getElementById("wh-url").value = c.webhook?.url || "";
  document.getElementById("wh-headers").value = c.webhook?.headers_json || "{}";

  document.getElementById("notif-logs-tbody").innerHTML = data.logs.length
    ? data.logs
        .map(
          (l) => `
      <tr>
        <td data-label="时间">${fmtTime(l.created_at)}</td>
        <td data-label="Run">${l.run_id ? `#${l.run_id}` : "测试"}</td>
        <td data-label="通道">${esc(l.channel)}</td>
        <td data-label="结果">${l.status === "sent" ? '<span class="badge success">成功</span>' : '<span class="badge failed">失败</span>'}</td>
        <td data-label="详情" class="sm">${esc(l.detail)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="muted">暂无推送记录。</td></tr>`;
}

function collectNotificationForm() {
  return {
    enabled: document.getElementById("notif-enabled").checked,
    notify_on: [...document.querySelectorAll(".notif-event:checked")].map((cb) => cb.value),
    notify_on_recovery: document.getElementById("notif-recovery").checked,
    cooldown_minutes: Number(document.getElementById("notif-cooldown").value || 60),
    use_proxy: document.getElementById("notif-use-proxy").checked,
    telegram: {
      enabled: document.getElementById("tg-enabled").checked,
      bot_token: document.getElementById("tg-token").value.trim(),
      chat_id: document.getElementById("tg-chat").value.trim(),
      api_base: document.getElementById("tg-base").value.trim() || "https://api.telegram.org",
    },
    feishu: {
      enabled: document.getElementById("fs-enabled").checked,
      webhook_url: document.getElementById("fs-url").value.trim(),
      secret: document.getElementById("fs-secret").value.trim(),
    },
    bark: {
      enabled: document.getElementById("bk-enabled").checked,
      server_url: document.getElementById("bk-server").value.trim() || "https://api.day.app",
      device_key: document.getElementById("bk-key").value.trim(),
      group: document.getElementById("bk-group").value.trim() || "gallery-dl",
    },
    webhook: {
      enabled: document.getElementById("wh-enabled").checked,
      url: document.getElementById("wh-url").value.trim(),
      headers_json: document.getElementById("wh-headers").value.trim() || "{}",
    },
  };
}

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.goto));
  });
  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".run-tabpanel").forEach((p) => p.classList.toggle("active", p.id === `run-tab-${btn.dataset.runtab}`));
    });
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.replace("/login");
  });

  document.getElementById("scheduler-pill").addEventListener("click", async (e) => {
    const paused = e.target.dataset.paused === "1";
    await api(paused ? "/api/scheduler/resume" : "/api/scheduler/pause", { method: "POST" });
    showToast(paused ? "定时调度已恢复" : "定时调度已暂停");
    loadDashboard();
  });

  document.getElementById("enable-all-tasks-btn").addEventListener("click", async () => {
    await api("/api/tasks/enable-all", { method: "POST" });
    showToast("已启用全部定时任务");
    loadDashboard();
  });
  document.getElementById("dismiss-legacy-banner-btn").addEventListener("click", async () => {
    await api("/api/tasks/dismiss-import-notice", { method: "POST" });
    document.getElementById("legacy-banner").classList.add("hidden");
  });

  document.getElementById("adhoc-proxy-mode").addEventListener("change", (e) => {
    document.getElementById("adhoc-proxy-custom-wrap").style.display = e.target.value === "custom" ? "" : "none";
  });

  document.getElementById("adhoc-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const statusEl = document.getElementById("adhoc-file-status");
    const clearBtn = document.getElementById("adhoc-file-clear");
    if (!file) {
      state.adhocFileText = "";
      statusEl.classList.add("hidden");
      clearBtn.classList.add("hidden");
      return;
    }
    const text = await file.text();
    state.adhocFileText = text;
    const cnt = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    statusEl.textContent = `已加载 ${file.name}（共 ${cnt} 条有效链接，提交时自动使用 gallery-dl -i 执行）`;
    statusEl.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
  });

  document.getElementById("adhoc-file-clear").addEventListener("click", () => {
    state.adhocFileText = "";
    document.getElementById("adhoc-file").value = "";
    document.getElementById("adhoc-file-status").classList.add("hidden");
    document.getElementById("adhoc-file-clear").classList.add("hidden");
  });

  document.getElementById("adhoc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const urlsEl = document.getElementById("adhoc-urls");
    if (!urlsEl.value.trim() && !state.adhocFileText.trim()) {
      urlsEl.classList.add("user-invalid-fallback");
      urlsEl.focus();
      return;
    }
    try {
      const res = await api("/api/download", {
        method: "POST",
        body: {
          urls: urlsEl.value,
          file_content: state.adhocFileText,
          proxy_mode: document.getElementById("adhoc-proxy-mode").value,
          proxy_url: document.getElementById("adhoc-proxy-url").value,
          subdir: document.getElementById("adhoc-subdir").value,
          postprocess_mode: document.getElementById("adhoc-pp-mode").value,
          postprocess_date_field: document.getElementById("adhoc-pp-date").value.trim(),
          postprocess_command: document.getElementById("adhoc-pp-cmd").value.trim(),
          skip_mode: document.getElementById("adhoc-skip").value.trim(),
          extra_args: document.getElementById("adhoc-extra").value,
          use_archive: document.getElementById("adhoc-archive").checked,
          archive_backfill: document.getElementById("adhoc-archive-backfill").checked,
          simulate: document.getElementById("adhoc-simulate").checked,
        },
      });
      urlsEl.value = "";
      state.adhocFileText = "";
      document.getElementById("adhoc-file").value = "";
      document.getElementById("adhoc-file-status").classList.add("hidden");
      document.getElementById("adhoc-file-clear").classList.add("hidden");
      showToast(`已入队 Run #${res.run_id}`);
      state.selectedRunId = res.run_id;
      switchView("runs");
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("adhoc-archive").addEventListener("change", (e) => {
    const bf = document.getElementById("adhoc-archive-backfill");
    bf.disabled = !e.target.checked;
    if (!e.target.checked) bf.checked = false;
  });
  document.getElementById("adhoc-pp-mode").addEventListener("change", refreshAdhocPostprocessUI);
  document.getElementById("adhoc-pp-date").addEventListener("input", refreshAdhocPostprocessUI);
  document.getElementById("adhoc-pp-cmd").addEventListener("input", refreshAdhocPostprocessUI);

  document.getElementById("refresh-dashboard-btn").addEventListener("click", loadDashboard);
  document.getElementById("new-task-btn").addEventListener("click", () => openTaskDialog(null));
  document.getElementById("tasks-batch-toggle-btn").addEventListener("click", () => {
    state.taskBatchMode = !state.taskBatchMode;
    if (!state.taskBatchMode) state.selectedTaskIds.clear();
    renderTasksTable();
  });
  document.getElementById("tasks-batch-exit-btn").addEventListener("click", () => {
    state.taskBatchMode = false;
    state.selectedTaskIds.clear();
    renderTasksTable();
  });
  document.getElementById("tasks-select-all").addEventListener("change", (e) => {
    if (e.target.checked) {
      state.tasks.forEach((t) => state.selectedTaskIds.add(t.id));
    } else {
      state.selectedTaskIds.clear();
    }
    renderTasksTable();
  });
  document.getElementById("tf-source-mode").addEventListener("change", syncTaskSourceMode);
  document.getElementById("tf-refresh-inputs-btn").addEventListener("click", () => loadInputFiles());
  document.getElementById("tf-upload-input-btn").addEventListener("click", async () => {
    const fileInput = document.getElementById("tf-upload-input-file");
    const file = fileInput.files?.[0];
    if (!file) return showToast("请先选择要上传的 .txt 文件");
    try {
      const content = await file.text();
      const res = await api("/api/inputs/upload", {
        method: "POST",
        body: { filename: file.name, content },
      });
      fileInput.value = "";
      await loadInputFiles(res.file.name);
      showToast(`已上传 ${res.file.name} (${res.file.url_count} 条 URL)`);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("tf-archive").addEventListener("change", (e) => {
    const bf = document.getElementById("tf-archive-backfill");
    bf.disabled = !e.target.checked;
    if (!e.target.checked) bf.checked = false;
  });
  document.getElementById("tf-proxy-mode").addEventListener("change", (e) => {
    document.getElementById("tf-proxy-url-wrap").style.display = e.target.value === "custom" ? "" : "none";
  });
  document.getElementById("tf-cron").addEventListener("input", previewTaskCron);
  document.getElementById("tf-pp-mode").addEventListener("change", refreshTaskPostprocessUI);
  document.getElementById("tf-pp-date").addEventListener("input", refreshTaskPostprocessUI);
  document.getElementById("tf-pp-cmd").addEventListener("input", refreshTaskPostprocessUI);

  document.getElementById("task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("tf-id").value;
    const srcMode = document.getElementById("tf-source-mode").value;
    const payload = {
      name: document.getElementById("tf-name").value.trim(),
      cron_expr: document.getElementById("tf-cron").value.trim(),
      urls: srcMode === "urls" ? document.getElementById("tf-urls").value : "",
      input_file: srcMode === "input_file" ? document.getElementById("tf-input-file").value : "",
      proxy_mode: document.getElementById("tf-proxy-mode").value,
      proxy_url: document.getElementById("tf-proxy-url").value.trim(),
      postprocess_mode: document.getElementById("tf-pp-mode").value,
      postprocess_date_field: document.getElementById("tf-pp-date").value.trim(),
      postprocess_command: document.getElementById("tf-pp-cmd").value.trim(),
      skip_mode: document.getElementById("tf-skip").value.trim(),
      subdir: document.getElementById("tf-subdir").value.trim(),
      extra_args: document.getElementById("tf-extra").value.trim(),
      filename_format: document.getElementById("tf-filename").value.trim(),
      enabled: document.getElementById("tf-enabled").checked,
      use_archive: document.getElementById("tf-archive").checked,
      archive_backfill: document.getElementById("tf-archive-backfill").checked,
    };
    try {
      if (id) {
        await api(`/api/tasks/${id}`, { method: "PUT", body: payload });
        showToast("任务已更新");
      } else {
        await api("/api/tasks", { method: "POST", body: payload });
        showToast("任务已创建");
      }
      document.getElementById("task-dialog").close();
      loadTasks();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("runs-status-filter").addEventListener("change", () => loadRuns());
  document.getElementById("log-search").addEventListener("input", renderLogLines);
  document.getElementById("log-only-errors").addEventListener("change", renderLogLines);

  document.getElementById("global-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/config/settings", {
        method: "PUT",
        body: {
          global_proxy: document.getElementById("cfg-global-proxy").value.trim(),
          default_skip: document.getElementById("cfg-default-skip").value.trim(),
          retries: Number(document.getElementById("cfg-retries").value || 4),
          timeout: Number(document.getElementById("cfg-timeout").value || 30),
          log_retention_days: Number(document.getElementById("cfg-retention").value || 30),
          max_concurrency: Number(document.getElementById("cfg-concurrency").value || 1),
          postprocess_default_sites: document
            .getElementById("cfg-pp-sites")
            .value.split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });
      showToast("全局设置已保存");
      loadConfigOverview();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("test-proxy-btn").addEventListener("click", async () => {
    const out = document.getElementById("proxy-test-result");
    out.textContent = "测试中…";
    try {
      const res = await api("/api/config/proxy-test", {
        method: "POST",
        body: { proxy_url: document.getElementById("cfg-global-proxy").value.trim() },
      });
      out.textContent = res.ok ? `连接成功 (HTTP ${res.status})` : `失败：${res.detail}`;
    } catch (err) {
      out.textContent = err.message;
    }
  });

  document.getElementById("change-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: {
          current_password: document.getElementById("pw-current").value,
          new_password: document.getElementById("pw-new").value,
        },
      });
      e.target.reset();
      showToast("密码已更新");
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("add-site-btn").addEventListener("click", () => openSiteDialog(""));
  document.getElementById("sf-pp").addEventListener("change", refreshSitePostprocessUI);
  document.getElementById("sf-pp-type").addEventListener("change", refreshSitePostprocessUI);
  document.getElementById("sf-pp-date").addEventListener("input", refreshSitePostprocessUI);
  document.getElementById("sf-pp-extra").addEventListener("input", refreshSitePostprocessUI);
  document.getElementById("sf-pp-cmd").addEventListener("input", refreshSitePostprocessUI);
  document.getElementById("site-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const site = document.getElementById("sf-site").value.trim();
    if (!site) return showToast("请输入站点标识");
    try {
      const res = await api(`/api/config/site/${encodeURIComponent(site)}`, {
        method: "PUT",
        body: {
          username: document.getElementById("sf-username").value.trim(),
          password: document.getElementById("sf-password").value,
          user_id: document.getElementById("sf-userid").value.trim(),
          api_key: document.getElementById("sf-apikey").value,
          browser: document.getElementById("sf-browser").value.trim(),
          user_agent: document.getElementById("sf-user-agent").value.trim(),
          filename: document.getElementById("sf-filename").value.trim(),
          skip: document.getElementById("sf-skip").value.trim(),
          cookies_input: document.getElementById("sf-cookies").value,
          clear_cookies: document.getElementById("sf-clear-cookies").checked,
          postprocess_enabled: document.getElementById("sf-pp").checked,
          postprocess_type: document.getElementById("sf-pp-type").value,
          postprocess_date_field: document.getElementById("sf-pp-date").value.trim(),
          postprocess_extra_args: document.getElementById("sf-pp-extra").value.trim(),
          postprocess_command: document.getElementById("sf-pp-cmd").value.trim(),
        },
      });
      document.getElementById("site-dialog").close();
      showToast(`站点 ${site} 已保存 (Cookies: ${res.cookie_count})`);
      loadConfigOverview();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("open-raw-config-btn").addEventListener("click", async () => {
    const data = await api("/api/config/raw");
    document.getElementById("rf-json").value = data.config_json;
    document.getElementById("raw-dialog").showModal();
  });

  document.getElementById("tw-token-toggle-btn").addEventListener("click", (e) => {
    const el = document.getElementById("tw-sync-token");
    const show = el.type === "password";
    el.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "隐藏" : "显示";
  });

  document.getElementById("tw-token-copy-btn").addEventListener("click", async () => {
    const val = document.getElementById("tw-sync-token").value;
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      showToast("同步 Token 已复制");
    } catch {
      const el = document.getElementById("tw-sync-token");
      el.type = "text";
      el.select();
      document.execCommand("copy");
      showToast("同步 Token 已复制");
    }
  });

  document.getElementById("tw-token-rotate-btn").addEventListener("click", async () => {
    if (!confirm("重置后旧油猴脚本的 Token 将失效，需重新下载脚本或更新 Token，确认继续？")) return;
    const res = await api("/api/twitter-sync/token/rotate", { method: "POST" });
    document.getElementById("tw-sync-token").value = res.token || "";
    showToast("已生成新的同步 Token");
  });

  document.getElementById("tw-scan-disk-btn").addEventListener("click", async () => {
    try {
      showToast("正在扫描 /gallery-dl/twitter 目录…");
      const res = await api("/api/twitter-sync/scan-disk", { method: "POST" });
      showToast(`扫描 ${res.scanned_files} 个文件，发现 ${res.found_ids} 个推文 ID，新增入库 ${res.inserted} 条`);
      await loadTwitterSyncStatus();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("tw-import-likejs-btn").addEventListener("click", async () => {
    const fileInput = document.getElementById("tw-likejs-file");
    const file = fileInput.files?.[0];
    if (!file) return showToast("请先选择 X 官方存档中的 like.js 文件");
    try {
      const content = await file.text();
      const res = await api("/api/twitter-sync/import-like-js", {
        method: "POST",
        body: { content },
      });
      fileInput.value = "";
      showToast(`解析 ${res.parsed} 条推文 ID，新增入库 ${res.inserted} 条`);
      await loadTwitterSyncStatus();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("raw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/config/raw", {
        method: "PUT",
        body: {
          note: document.getElementById("rf-note").value.trim(),
          config_json: document.getElementById("rf-json").value,
        },
      });
      document.getElementById("raw-dialog").close();
      showToast("JSON 配置已保存");
      loadConfigOverview();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById("notify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/notifications", { method: "PUT", body: collectNotificationForm() });
      showToast("通知配置已保存");
      loadNotifications();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.querySelectorAll(".test-channel-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ch = btn.dataset.channel;
      const out = document.getElementById("notif-test-status");
      out.textContent = `正在发送 ${ch} 测试…`;
      try {
        const res = await api("/api/notifications/test", {
          method: "POST",
          body: { channel: ch, config: collectNotificationForm() },
        });
        const first = res.results?.[0];
        out.textContent = first?.ok ? `${ch} 测试发送成功` : `${ch} 发送失败：${first?.detail || "未知错误"}`;
        loadNotifications();
      } catch (err) {
        out.textContent = err.message;
      }
    });
  });

  document.getElementById("alerts-read-all-btn").addEventListener("click", async () => {
    const res = await api("/api/alerts/read", { method: "POST", body: { all: true } });
    state.alerts = res.items || [];
    state.unreadAlertsCount = Number(res.unread_count || 0);
    renderAlertsPopover();
  });
  document.getElementById("alerts-clear-all-btn").addEventListener("click", async () => {
    const res = await api("/api/alerts/clear", { method: "POST", body: { all: true } });
    state.alerts = res.items || [];
    state.unreadAlertsCount = Number(res.unread_count || 0);
    renderAlertsPopover();
  });

  // Ensure action & alert popovers always stay anchored to their trigger button
  // (covers browsers without CSS Anchor Positioning and containment ancestors like container-type).
  document.body.addEventListener("toggle", (e) => {
    const pop = e.target;
    if (!pop.classList?.contains("action-popover") && !pop.classList?.contains("alerts-popover")) return;
    if (e.newState !== "open") {
      pop.style.positionArea = "";
      pop.style.positionAnchor = "";
      pop.style.position = "";
      pop.style.inset = "";
      pop.style.margin = "";
      pop.style.top = "";
      pop.style.left = "";
      return;
    }
    if (pop.id === "alerts-popover") {
      loadAlerts();
    }
    const trigger = document.querySelector(`[popovertarget="${pop.id}"]`);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const nearTrigger =
      Math.abs(popRect.right - rect.right) <= 48 &&
      ((popRect.top >= rect.bottom - 4 && popRect.top <= rect.bottom + 24) ||
        (popRect.bottom <= rect.top + 4 && popRect.bottom >= rect.top - 24));
    if (!nearTrigger) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const top =
        spaceBelow >= popRect.height + 8
          ? rect.bottom + 4
          : Math.max(8, rect.top - popRect.height - 4);
      const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.right - popRect.width));
      pop.style.positionArea = "none";
      pop.style.positionAnchor = "none";
      pop.style.position = "fixed";
      pop.style.inset = "auto";
      pop.style.margin = "0";
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    }
  }, true);

  // Task switch & multi-select checkbox change handler
  document.body.addEventListener("change", async (e) => {
    const input = e.target;
    if (input.dataset?.toggleTask) {
      const tid = input.dataset.toggleTask;
      try {
        await api(`/api/tasks/${tid}/toggle`, { method: "POST" });
        await loadTasks();
      } catch (err) {
        input.checked = !input.checked;
        showToast(err.message);
      }
    } else if (input.dataset?.selectTask) {
      const tid = Number(input.dataset.selectTask);
      if (input.checked) state.selectedTaskIds.add(tid);
      else state.selectedTaskIds.delete(tid);
      syncTaskBatchUI();
    }
  });

  // Delegated clicks for dynamic rows/buttons
  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.classList.contains("popover-item")) {
      btn.closest("[popover]")?.hidePopover?.();
    }
    try {
      if (btn.dataset.batchAction) {
        const action = btn.dataset.batchAction;
        const ids = [...state.selectedTaskIds];
        if (!ids.length) return;
        if (action === "delete" && !confirm(`确定删除选中的 ${ids.length} 个定时任务？历史运行记录仍会保留。`)) return;
        const res = await api("/api/tasks/batch", { method: "POST", body: { action, task_ids: ids } });
        const verb = action === "enable" ? "启用" : action === "disable" ? "停用" : "删除";
        showToast(`已批量${verb} ${res.affected} 个任务`);
        if (action === "delete") state.selectedTaskIds.clear();
        await loadTasks();
      } else if (btn.dataset.alertJump) {
        const key = btn.dataset.alertJump;
        const runId = btn.dataset.alertRun;
        const targetView = btn.dataset.alertView || "runs";
        api("/api/alerts/read", { method: "POST", body: { alert_key: key } })
          .then((res) => {
            state.alerts = res.items || [];
            state.unreadAlertsCount = Number(res.unread_count || 0);
            renderAlertsPopover();
          })
          .catch(() => {});
        document.getElementById("alerts-popover")?.hidePopover?.();
        if (runId) {
          state.selectedRunId = Number(runId);
          switchView("runs");
        } else {
          switchView(targetView);
        }
      } else if (btn.dataset.alertRead) {
        const res = await api("/api/alerts/read", { method: "POST", body: { alert_key: btn.dataset.alertRead } });
        state.alerts = res.items || [];
        state.unreadAlertsCount = Number(res.unread_count || 0);
        renderAlertsPopover();
      } else if (btn.dataset.alertClear) {
        const res = await api("/api/alerts/clear", { method: "POST", body: { alert_key: btn.dataset.alertClear } });
        state.alerts = res.items || [];
        state.unreadAlertsCount = Number(res.unread_count || 0);
        renderAlertsPopover();
      } else if (btn.dataset.goto) {
        switchView(btn.dataset.goto);
      } else if (btn.dataset.inspectRun) {
        state.selectedRunId = Number(btn.dataset.inspectRun);
        switchView("runs");
      } else if (btn.dataset.selectRun) {
        await selectRun(Number(btn.dataset.selectRun));
      } else if (btn.dataset.cancelRun) {
        await api(`/api/runs/${btn.dataset.cancelRun}/cancel`, { method: "POST" });
        showToast("已发送中止信号");
        if (state.view === "dashboard") loadDashboard();
        else loadRuns(Number(btn.dataset.cancelRun));
      } else if (btn.dataset.retryRun) {
        const res = await api(`/api/runs/${btn.dataset.retryRun}/retry`, { method: "POST" });
        showToast(`已入队重试 Run #${res.run_id}`);
        loadRuns(res.run_id);
      } else if (btn.dataset.runTask || btn.dataset.simTask) {
        const tid = btn.dataset.runTask || btn.dataset.simTask;
        const sim = Boolean(btn.dataset.simTask);
        const res = await api(`/api/tasks/${tid}/run`, { method: "POST", body: { simulate: sim } });
        showToast(res.already_active ? `任务已在执行中 (Run #${res.run_id})` : `已入队 Run #${res.run_id}`);
        state.selectedRunId = res.run_id;
        switchView("runs");
      } else if (btn.dataset.editTask) {
        const t = state.tasks.find((x) => x.id === Number(btn.dataset.editTask));
        if (t) openTaskDialog(t);
      } else if (btn.dataset.deleteTask) {
        if (!confirm("确定删除此定时任务？历史运行记录仍会保留。")) return;
        await api(`/api/tasks/${btn.dataset.deleteTask}`, { method: "DELETE" });
        showToast("任务已删除");
        loadTasks();
      } else if (btn.dataset.editSite) {
        await openSiteDialog(btn.dataset.editSite);
      } else if (btn.dataset.deleteSite) {
        if (!confirm(`确定删除站点 ${btn.dataset.deleteSite} 的配置与凭据？`)) return;
        await api(`/api/config/site/${encodeURIComponent(btn.dataset.deleteSite)}`, { method: "DELETE" });
        loadConfigOverview();
      } else if (btn.dataset.restoreSnap) {
        if (!confirm(`确定回滚配置到快照 #${btn.dataset.restoreSnap}？`)) return;
        await api(`/api/config/snapshots/${btn.dataset.restoreSnap}/restore`, { method: "POST" });
        showToast("配置已回滚");
        loadConfigOverview();
      }
    } catch (err) {
      showToast(err.message);
    }
  });
}

initDialogs();
initStaticSwitches();
initThemeControl();
bindEvents();
loadDashboard();
loadAlerts();
state.pollTimer = setInterval(() => {
  if (state.view === "dashboard") loadDashboard().catch(() => {});
}, 8000);
