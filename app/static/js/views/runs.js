import { api, getSitesHealth } from "../api.js";
import { createLogViewer } from "../components/log-viewer.js";
import { navigate } from "../router.js";
import {
  esc,
  fmtDuration,
  fmtTime,
  matchSitesLocally,
  showToast,
  statusBadge,
} from "../util.js";

const LOG_WINDOW_MAX = 5000;

let hostEl = null;
let unmounted = false;
let runs = [];
let totalRuns = 0;
let selectedRunId = null;
let selectedRun = null;
let selectedFiles = [];
let selectedFileSet = new Set();
let activeRunTab = "log";
let filterStatus = "";
let filterTaskId = "";
let tasksList = [];
let sitesCache = [];

let runStream = null;
let elapsedTimer = null;
let logViewer = null;

function closeRunStream() {
  if (runStream) {
    runStream.close();
    runStream = null;
  }
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function normalizeErrorLine(line) {
  return line
    .replace(/https?:\/\/\S+/gi, "<URL>")
    .replace(/\b\d{4,}\b/g, "<ID>")
    .replace(/\[[0-9]{4}-[0-9]{2}-[0-9]{2}[^\]]*\]/g, "")
    .trim()
    .slice(0, 140);
}

function analyzeErrorGroups(lines) {
  const groups = new Map();
  for (const raw of lines) {
    const isErr = /\[error\]|ChallengeError|HttpError|HTTP\/\d\.\d"\s+[45]\d\d|\b(401|403|429|500|502|503)\b|Unauthorized|Forbidden|Timeout|ProxyError/i.test(raw);
    const isWarn = !isErr && /\[warning\]|\[warn\]|\[postprocess\]\[warn\]/i.test(raw);
    if (!isErr && !isWarn) continue;

    const key = normalizeErrorLine(raw);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        severity: isErr ? "error" : "warn",
        count: 0,
        samples: [],
        isAuth: /401|403|auth|cookie|login|unauthorized|forbidden|challengeerror/i.test(raw),
        isNetwork: /proxy|timeout|timed out|connection|ssl|reset|429|502|503/i.test(raw),
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (g.samples.length < 3 && !g.samples.includes(raw)) {
      g.samples.push(raw);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function renderRunList() {
  const box = document.getElementById("runs-list-box");
  const loadMoreBtn = document.getElementById("runs-load-more-btn");
  if (!box) return;

  if (!runs.length) {
    box.innerHTML = `<div class="muted sm">暂无运行记录。</div>`;
  } else {
    box.innerHTML = runs
      .map(
        (r) => `
      <a class="run-item ${Number(r.id) === Number(selectedRunId) ? "active" : ""}" href="#/runs/${r.id}">
        <div class="run-item-top">
          ${statusBadge(r.status, "status-pill")}
          <strong>#${r.id} ${esc(r.task_name)}</strong>
        </div>
        <div class="muted sm">+${r.downloaded_count} 新增 · ${r.skipped_count} 跳过 · ${fmtTime(r.created_at)}</div>
      </a>`
      )
      .join("");
  }

  if (loadMoreBtn) {
    loadMoreBtn.classList.toggle("hidden", runs.length >= totalRuns || !runs.length);
  }
}

function renderRunHeader() {
  const titleEl = document.getElementById("run-detail-title");
  const metaEl = document.getElementById("run-detail-meta");
  const r = selectedRun;
  if (!titleEl || !metaEl || !r) return;

  let dur = r.duration_sec;
  if (r.status === "running" && r.started_at) {
    const ms = new Date(r.started_at).getTime();
    if (!Number.isNaN(ms)) dur = Math.max(0, (Date.now() - ms) / 1000);
  }

  titleEl.innerHTML = `${statusBadge(r.status, "status-pill")} <span>#${r.id} ${esc(r.task_name)}</span>`;
  metaEl.innerHTML = `
    触发：${esc(r.trigger_type)}${r.simulate ? " (模拟)" : ""}
    ${r.task_id ? ` · <a href="#/tasks/${r.task_id}">查看所属任务</a>` : ""}
    · 新增 ${r.downloaded_count} · 跳过 ${r.skipped_count}
    · 后处理 ${r.postprocess_ok} 成功 / ${r.postprocess_warn} 警告
    · 耗时 ${fmtDuration(dur)}
  `;

  const cardSub = hostEl?.querySelector(`a.run-item[href="#/runs/${r.id}"] .muted`);
  if (cardSub) {
    cardSub.textContent = `+${r.downloaded_count} 新增 · ${r.skipped_count} 跳过 · ${fmtTime(r.created_at)}`;
  }
}

function renderFilesList() {
  const cntEl = document.getElementById("run-files-count");
  const ul = document.getElementById("run-files-list");
  if (cntEl) cntEl.textContent = String(selectedFiles.length);
  if (!ul) return;

  const q = (document.getElementById("run-files-search")?.value || "").trim().toLowerCase();
  const list = q ? selectedFiles.filter((f) => f.file_path.toLowerCase().includes(q)) : selectedFiles;
  ul.innerHTML = list.length
    ? list
        .map(
          (f) => `
      <li class="file-path-row">
        <span>${esc(f.file_path)}</span>
        <button type="button" class="btn ghost xs" data-copy-path="${esc(f.file_path)}">复制</button>
      </li>`
        )
        .join("")
    : `<li class="muted sm" style="padding:0.5rem 0;">${selectedFiles.length ? "没有匹配的文件路径。" : "本次运行暂无新下载落盘文件。"}</li>`;
}

function renderErrorsSummary() {
  const lines = logViewer ? logViewer.getAllLines() : [];
  const groups = analyzeErrorGroups(lines);
  const cntEl = document.getElementById("run-errors-count");
  const box = document.getElementById("run-errors-box");
  if (cntEl) cntEl.textContent = String(groups.length);
  if (!box) return;

  const r = selectedRun;
  const matchedSites = r ? matchSitesLocally((r.urls || []).join("\n"), sitesCache) : [];
  const hasAuthIssue = r?.status === "auth_error" || groups.some((g) => g.isAuth);
  const hasNetIssue = groups.some((g) => g.isNetwork);

  const fixButtons = [];
  if (hasAuthIssue) {
    if (matchedSites.length) {
      matchedSites.forEach((s) => {
        fixButtons.push(`<a class="btn danger sm" href="#/sites/${encodeURIComponent(s)}">更新 ${esc(s)} Cookie</a>`);
      });
    } else {
      fixButtons.push(`<a class="btn danger sm" href="#/sites">检查站点凭据</a>`);
    }
  }
  if (hasNetIssue) {
    fixButtons.push(`<a class="btn sm" href="#/settings/general">检查代理设置</a>`);
  }
  if (r && !["queued", "running"].includes(r.status)) {
    fixButtons.push(`<button type="button" class="btn primary sm" data-retry-run="${r.id}">重试本次运行</button>`);
  }

  const bannerHtml =
    groups.length || (r && ["failed", "auth_error", "partial"].includes(r.status))
      ? `
      <div class="notice ${r?.status === "auth_error" ? "danger" : "warn"} banner-row">
        <div>
          <strong>${r?.error_summary ? esc(r.error_summary) : "检测到异常日志"}</strong>
          <div class="muted xs">共归并 ${groups.length} 类异常模式 · 建议结合下方示例排查</div>
        </div>
        <div class="row-actions">${fixButtons.join("")}</div>
      </div>`
      : `<div class="notice sm muted">当前日志窗口中未发现错误或警告。</div>`;

  const groupsHtml = groups
    .map(
      (g) => `
    <div class="err-group ${g.severity === "warn" ? "is-warn" : ""}">
      <div class="row-actions between" style="margin-bottom:0.4rem;">
        <span class="badge ${g.severity === "warn" ? "partial" : "failed"}">${g.severity === "warn" ? "警告" : "错误"} × ${g.count}</span>
        <span class="xs muted">${g.isAuth ? "认证/权限相关" : g.isNetwork ? "网络/代理相关" : "运行时异常"}</span>
      </div>
      <pre class="cmd-preview">${esc(g.samples.join("\n"))}</pre>
    </div>`
    )
    .join("");

  box.innerHTML = `<div class="stack sm-gap">${bannerHtml}${groupsHtml}</div>`;
}

function switchRunTab(tab) {
  activeRunTab = tab;
  hostEl?.querySelectorAll("[data-runtab]").forEach((b) => {
    const active = b.dataset.runtab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  hostEl?.querySelectorAll(".run-tabpanel").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `run-tab-${tab}`);
  });
  if (tab === "errors") renderErrorsSummary();
}

async function loadRunsList({ append = false } = {}) {
  const qs = new URLSearchParams({ limit: "40" });
  if (filterStatus) qs.set("status", filterStatus);
  if (filterTaskId) qs.set("task_id", filterTaskId);
  if (append && runs.length) qs.set("before_id", String(runs[runs.length - 1].id));

  const data = await api(`/api/runs?${qs.toString()}`);
  if (unmounted) return;
  totalRuns = Number(data.total || 0);
  if (append) {
    const existing = new Set(runs.map((x) => x.id));
    for (const r of data.runs || []) {
      if (!existing.has(r.id)) runs.push(r);
    }
  } else {
    runs = data.runs || [];
  }
  renderRunList();
}

async function selectRun(runId) {
  closeRunStream();
  selectedRunId = runId;
  const layout = document.getElementById("runs-layout");
  const detailPane = document.getElementById("runs-detail-pane");
  if (layout) layout.classList.toggle("has-selected", Boolean(runId));
  renderRunList();

  if (!runId || !detailPane) {
    if (detailPane) {
      detailPane.innerHTML = `<div class="card muted">请从左侧选择一条运行记录查看日志与文件详情。</div>`;
    }
    return;
  }

  detailPane.innerHTML = `<div class="card muted">正在加载 Run #${runId}…</div>`;
  const detail = await api(`/api/runs/${runId}`);
  if (unmounted) return;

  const r = detail.run;
  selectedRun = r;
  selectedFiles = detail.files || [];
  selectedFileSet = new Set(selectedFiles.map((f) => f.file_path));
  const isLive = r.status === "queued" || r.status === "running";

  detailPane.innerHTML = `
    <section class="card stack sm-gap">
      <div class="card-head" style="margin-bottom:0.2rem;">
        <div>
          <div class="row-actions" style="margin-bottom:0.3rem;">
            <a class="btn ghost sm runs-back-btn" href="#/runs">← 运行列表</a>
            <h2 id="run-detail-title" style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;"></h2>
          </div>
          <div class="muted sm" id="run-detail-meta"></div>
        </div>
        <div class="row-actions">
          ${isLive
            ? `<button type="button" class="btn danger sm" data-cancel-run="${r.id}">中止任务</button>`
            : `<button type="button" class="btn sm" data-retry-run="${r.id}">重试</button>`}
          <a class="btn sm" href="/api/runs/${r.id}/log?download=1">下载日志</a>
          <button type="button" class="btn sm" id="run-copy-link-btn">复制链接</button>
        </div>
      </div>

      <div class="subtabs" role="tablist" aria-label="运行详情标签">
        <button type="button" class="subtab-btn active" role="tab" aria-selected="true" data-runtab="log">实时日志</button>
        <button type="button" class="subtab-btn" role="tab" aria-selected="false" data-runtab="files">新增文件 (<span id="run-files-count">0</span>)</button>
        <button type="button" class="subtab-btn" role="tab" aria-selected="false" data-runtab="errors">错误汇总 (<span id="run-errors-count">0</span>)</button>
      </div>

      <div id="run-tab-log" class="run-tabpanel"></div>

      <div id="run-tab-files" class="run-tabpanel hidden stack sm-gap">
        <div class="row-actions between">
          <span class="muted sm">本次运行新落盘文件路径（媒体浏览请使用 Immich）</span>
          <input type="search" id="run-files-search" placeholder="过滤路径…" style="max-width:240px;" aria-label="过滤文件路径">
        </div>
        <ul id="run-files-list" class="file-path-list"></ul>
      </div>

      <div id="run-tab-errors" class="run-tabpanel hidden">
        <div id="run-errors-box"></div>
      </div>
    </section>
  `;

  if (logViewer) logViewer.destroy();
  logViewer = createLogViewer(document.getElementById("run-tab-log"), { maxLines: LOG_WINDOW_MAX });
  renderRunHeader();
  renderFilesList();
  switchRunTab(activeRunTab);

  if (isLive) {
    elapsedTimer = setInterval(() => {
      if (selectedRun?.status === "running") renderRunHeader();
    }, 1000);
    const es = new EventSource(`/api/runs/${runId}/stream?tail=800`);
    runStream = es;
    es.onmessage = (ev) => {
      if (unmounted) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "log_snapshot") {
          logViewer.setLines(msg.lines || [], msg.truncated);
          renderErrorsSummary();
        } else if (msg.type === "log") {
          logViewer.appendLine(msg.line);
        } else if (msg.type === "stats" && selectedRun) {
          selectedRun.status = "running";
          Object.assign(selectedRun, {
            downloaded_count: msg.downloaded_count,
            skipped_count: msg.skipped_count,
            postprocess_ok: msg.postprocess_ok,
            postprocess_warn: msg.postprocess_warn,
            duration_sec: msg.duration_sec,
          });
          renderRunHeader();
        } else if (msg.type === "file") {
          if (!selectedFileSet.has(msg.file_path)) {
            selectedFileSet.add(msg.file_path);
            selectedFiles.push({ file_path: msg.file_path });
            renderFilesList();
          }
        } else if (msg.type === "done") {
          closeRunStream();
          loadRunsList();
          selectRun(runId);
        }
      } catch {}
    };
  } else {
    logViewer.setLines(detail.log_lines || [], detail.log_truncated);
    renderErrorsSummary();
  }
}

export async function mount(el, params) {
  unmounted = false;
  hostEl = el;
  selectedRunId = params.id ? Number(params.id) : null;
  activeRunTab = "log";

  const [tasksRes, sites] = await Promise.all([
    api("/api/tasks").catch(() => ({ tasks: [] })),
    getSitesHealth().catch(() => []),
  ]);
  if (unmounted) return;
  tasksList = tasksRes.tasks || [];
  sitesCache = sites;

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>运行记录与日志</h1>
        <p class="muted sm" style="margin:0.2rem 0 0;">支持虚拟滚动实时日志、新增文件清单与错误自动归并</p>
      </div>
    </div>

    <div id="runs-layout" class="runs-layout ${selectedRunId ? "has-selected" : ""}">
      <section class="card runs-list-pane stack sm-gap">
        <div class="form-grid-2">
          <select id="runs-status-filter" aria-label="按状态筛选">
            <option value="">全部状态</option>
            <option value="running">运行中</option>
            <option value="queued">排队中</option>
            <option value="success">成功</option>
            <option value="partial">部分失败</option>
            <option value="auth_error">认证失效</option>
            <option value="failed">失败</option>
            <option value="cancelled">已中止</option>
          </select>
          <select id="runs-task-filter" aria-label="按任务筛选">
            <option value="">全部任务</option>
            ${tasksList.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
          </select>
        </div>
        <div id="runs-list-box" class="run-cards">
          <div class="muted sm">正在加载…</div>
        </div>
        <button type="button" id="runs-load-more-btn" class="btn ghost sm hidden">加载更多</button>
      </section>

      <div id="runs-detail-pane" class="runs-detail-pane"></div>
    </div>
  `;

  document.getElementById("runs-status-filter").value = filterStatus;
  document.getElementById("runs-task-filter").value = filterTaskId;

  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  el.addEventListener("input", onInput);

  await loadRunsList();
  if (!selectedRunId && runs.length && window.innerWidth > 900) {
    selectedRunId = runs[0].id;
  }
  await selectRun(selectedRunId);
}

function onInput(e) {
  if (e.target.id === "run-files-search") renderFilesList();
}

async function onChange(e) {
  if (e.target.id === "runs-status-filter") {
    filterStatus = e.target.value;
    await loadRunsList();
  } else if (e.target.id === "runs-task-filter") {
    filterTaskId = e.target.value;
    await loadRunsList();
  }
}

async function onClick(e) {
  const tabBtn = e.target.closest("[data-runtab]");
  if (tabBtn) {
    switchRunTab(tabBtn.dataset.runtab);
    return;
  }
  const btn = e.target.closest("button");
  if (!btn) return;
  try {
    if (btn.id === "runs-load-more-btn") {
      await loadRunsList({ append: true });
    } else if (btn.id === "run-copy-link-btn" && selectedRunId) {
      const url = `${location.origin}/#/runs/${selectedRunId}`;
      await navigator.clipboard.writeText(url);
      showToast("运行链接已复制");
    } else if (btn.dataset.copyPath) {
      await navigator.clipboard.writeText(btn.dataset.copyPath);
      showToast("路径已复制");
    } else if (btn.dataset.cancelRun) {
      await api(`/api/runs/${btn.dataset.cancelRun}/cancel`, { method: "POST" });
      showToast("已发送中止信号");
      await loadRunsList();
      await selectRun(Number(btn.dataset.cancelRun));
    } else if (btn.dataset.retryRun) {
      const res = await api(`/api/runs/${btn.dataset.retryRun}/retry`, { method: "POST" });
      showToast(`已入队重试 Run #${res.run_id}`);
      navigate(`#/runs/${res.run_id}`);
    }
  } catch (err) {
    showToast(err.message, "danger");
  }
}

export function onEvent(ev) {
  if (["run_queued", "run_started", "run_finished", "poll_tick"].includes(ev.type)) {
    loadRunsList().catch(() => {});
  }
}

export function unmount() {
  unmounted = true;
  closeRunStream();
  if (logViewer) {
    logViewer.destroy();
    logViewer = null;
  }
  if (hostEl) {
    hostEl.removeEventListener("click", onClick);
    hostEl.removeEventListener("change", onChange);
    hostEl.removeEventListener("input", onInput);
  }
  hostEl = null;
}
