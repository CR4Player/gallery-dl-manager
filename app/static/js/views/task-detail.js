import { api, getSitesHealth } from "../api.js";
import { mountDownloadOptions } from "../components/download-options.js";
import { navigate } from "../router.js";
import {
  confirmDialog,
  debounce,
  esc,
  fmtDuration,
  fmtTime,
  HAS_NATIVE_SWITCH,
  healthBadge,
  showToast,
  statusBadge,
  upgradeSwitches,
} from "../util.js";

let hostEl = null;
let unmounted = false;
let optionsApi = null;
let currentTaskId = null;
let activeTab = "overview";

const CRON_PRESETS = [
  { label: "每小时", expr: "0 * * * *" },
  { label: "每 6 小时", expr: "0 */6 * * *" },
  { label: "每天 03:00", expr: "0 3 * * *" },
  { label: "每周日 04:00", expr: "0 4 * * 0" },
];

async function loadTaskDetailFallback(taskId) {
  const [listRes, runsRes] = await Promise.all([
    api("/api/tasks"),
    api(`/api/runs?task_id=${taskId}&limit=30`),
  ]);
  const task = (listRes.tasks || []).find((t) => Number(t.id) === Number(taskId));
  if (!task) throw new Error("任务不存在");
  const runs = runsRes.runs || [];
  const total = runs.length;
  const success = runs.filter((r) => r.status === "success").length;
  const finished = runs.filter((r) => !["queued", "running"].includes(r.status)).length;
  const durs = runs.map((r) => r.duration_sec).filter((d) => d != null);
  return {
    task,
    recent_runs: runs,
    sites: task.sites || [],
    health: {
      total,
      success,
      success_rate: finished > 0 ? success / finished : null,
      avg_duration_sec: durs.length ? durs.reduce((a, b) => a + Number(b), 0) / durs.length : null,
      total_downloaded: runs.reduce((acc, r) => acc + Number(r.downloaded_count || 0), 0),
    },
  };
}

async function fetchInputOptions(selected = "") {
  const sel = document.getElementById("td-input-file");
  if (!sel) return;
  try {
    const res = await api("/api/inputs");
    const files = res.files || [];
    if (!files.length) {
      sel.innerHTML = `<option value="">(暂无文件，请先上传或放入 /data/inputs/)</option>`;
      return;
    }
    sel.innerHTML = files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)} (${f.url_count} 条 URL)</option>`).join("");
    if (selected && files.some((f) => f.name === selected)) {
      sel.value = selected;
    }
  } catch {}
}

async function previewCronExpr() {
  const box = document.getElementById("td-cron-preview");
  const expr = document.getElementById("td-cron")?.value.trim() || "";
  if (!box) return;
  try {
    const res = await api("/api/cron/preview", { method: "POST", body: { cron_expr: expr } });
    box.className = "notice info sm";
    box.innerHTML = `<strong>${esc(res.description)}</strong> · 未来 3 次：${(res.next_runs || []).map(esc).join(" | ")}`;
  } catch (err) {
    box.className = "notice danger sm";
    box.textContent = err.message;
  }
}

function syncSourceMode() {
  const mode = document.getElementById("td-source-mode")?.value || "urls";
  document.getElementById("td-urls-wrap")?.classList.toggle("hidden", mode !== "urls");
  document.getElementById("td-input-wrap")?.classList.toggle("hidden", mode !== "input_file");
}

function renderSettingsForm(task = null) {
  const isNew = !task;
  const srcMode = task?.input_file ? "input_file" : "urls";
  return `
    <form id="task-edit-form" class="card stack" novalidate>
      <div class="form-grid-2">
        <div class="field">
          <div class="label-row">
            <label for="td-name">任务名称</label>
            <span class="hint">必填</span>
          </div>
          <input id="td-name" type="text" required value="${esc(task?.name || "")}" placeholder="例如 Twitter 点赞">
        </div>
        <div class="field">
          <div class="label-row">
            <label for="td-cron">Cron 表达式 (5 段)</label>
            <span class="hint">分 时 日 月 周</span>
          </div>
          <input id="td-cron" type="text" required value="${esc(task?.cron_expr || "0 */6 * * *")}">
        </div>
      </div>

      <div class="row-actions">
        <span class="hint">快捷周期：</span>
        ${CRON_PRESETS.map((p) => `<button type="button" class="chip-btn" data-cron-preset="${esc(p.expr)}">${esc(p.label)}</button>`).join("")}
      </div>
      <div id="td-cron-preview" class="notice info sm">正在计算调度时间…</div>

      <div class="field">
        <label for="td-source-mode">抓取来源</label>
        <select id="td-source-mode">
          <option value="urls" ${srcMode === "urls" ? "selected" : ""}>直接填写 URL 列表</option>
          <option value="input_file" ${srcMode === "input_file" ? "selected" : ""}>NAS 输入文件 (/data/inputs/*.txt)</option>
        </select>
      </div>

      <div class="field ${srcMode === "urls" ? "" : "hidden"}" id="td-urls-wrap">
        <label for="td-urls">抓取 URL（每行一个）</label>
        <textarea id="td-urls" rows="4" placeholder="https://x.com/...">${esc((task?.urls || []).join("\n"))}</textarea>
      </div>

      <div class="sub-panel stack sm-gap ${srcMode === "input_file" ? "" : "hidden"}" id="td-input-wrap">
        <div class="field">
          <label for="td-input-file">选择 NAS 输入文件 (/data/inputs/)</label>
          <span class="hint">若链接列表最新在前，日常增量建议 Skip 设为 <code>exit:10</code></span>
          <div class="input-with-btn">
            <select id="td-input-file"></select>
            <button type="button" class="btn ghost sm" id="td-refresh-inputs-btn">刷新</button>
          </div>
        </div>
        <div class="field">
          <label for="td-upload-file">上传 / 覆盖 .txt 列表文件</label>
          <div class="file-picker-row">
            <input id="td-upload-file" type="file" accept=".txt,text/plain" class="file-input">
            <button type="button" class="btn ghost sm" id="td-upload-btn">上传到 NAS</button>
          </div>
        </div>
      </div>

      <div class="field">
        <label for="td-notes">备注（可选）</label>
        <input id="td-notes" type="text" value="${esc(task?.notes || "")}" placeholder="任务用途或说明">
      </div>

      <div id="td-options-slot"></div>

      <div class="row-actions between">
        <label class="checkbox-inline">
          <input type="checkbox" switch role="switch" class="switch-ok" id="td-enabled" ${task ? (task.enabled ? "checked" : "") : "checked"}> 启用定时调度
        </label>
        <div class="row-actions">
          <a class="btn ghost" href="#/tasks">返回列表</a>
          <button type="submit" class="btn primary">${isNew ? "创建任务" : "保存设置"}</button>
        </div>
      </div>
    </form>
  `;
}

async function renderOverviewTab(detail, sitesHealth) {
  const { task, recent_runs: runs, health, sites } = detail;
  const bySite = new Map((sitesHealth || []).map((s) => [s.site, s]));
  const rateText = health.success_rate != null ? `${Math.round(health.success_rate * 100)}%` : "-";

  return `
    <div class="stats-grid">
      <div class="card stat-card"><span class="muted sm">近期成功率 (近 ${health.total} 次)</span><strong>${rateText}</strong></div>
      <div class="card stat-card"><span class="muted sm">近 30 次累计新增</span><strong>${health.total_downloaded ?? 0}</strong></div>
      <div class="card stat-card"><span class="muted sm">平均耗时</span><strong>${fmtDuration(health.avg_duration_sec)}</strong></div>
      <div class="card stat-card"><span class="muted sm">当前连续异常</span><strong style="color:${task.consecutive_failures > 0 ? "var(--danger)" : "inherit"}">${task.consecutive_failures}</strong></div>
    </div>

    <div class="two-col">
      <section class="card stack sm-gap">
        <h2 style="margin:0; font-size:1.05rem;">调度与来源</h2>
        <div class="sm">Cron：<code>${esc(task.cron_expr)}</code> · ${esc(task.cron_desc)}</div>
        ${task.next_runs?.length
          ? `<div class="stack xs-gap"><span class="muted sm">未来 3 次预计执行：</span>${task.next_runs.map((n) => `<div class="xs mono">${fmtTime(n)}</div>`).join("")}</div>`
          : `<div class="muted sm">当前已停用定时调度</div>`}
        <div class="stack xs-gap">
          <span class="muted sm">抓取目标：</span>
          ${task.input_file ? `<code>-i /data/inputs/${esc(task.input_file)}</code>` : `<pre class="cmd-preview">${esc((task.urls || []).join("\n"))}</pre>`}
        </div>
      </section>

      <section class="card stack sm-gap">
        <h2 style="margin:0; font-size:1.05rem;">关联站点凭据健康</h2>
        ${sites?.length
          ? sites
              .map((s) => {
                const info = bySite.get(s);
                return `
                  <div class="upcoming-item">
                    <div class="row-actions">
                      <strong>${esc(s)}</strong>
                      ${healthBadge(info?.health || "unknown")}
                      <span class="muted xs">${info ? `Cookie: ${info.cookie_count}` : "未配置"}</span>
                    </div>
                    <a class="btn ghost sm" href="#/sites/${encodeURIComponent(s)}">站点配置</a>
                  </div>`;
              })
              .join("")
          : `<div class="muted sm">暂未识别到具体站点域名</div>`}
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>最近运行历史 (${runs.length})</h2>
        <a class="btn ghost sm" href="#/runs">在运行中心查看</a>
      </div>
      <div tabindex="0" role="region" aria-labelledby="td-runs-cap" class="table-wrapper">
        <table class="data-table">
          <caption id="td-runs-cap" class="visually-hidden">任务最近运行记录</caption>
          <thead>
            <tr>
              <th>ID</th>
              <th>触发</th>
              <th>状态</th>
              <th>新增 / 跳过</th>
              <th>耗时</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${runs.length
              ? runs
                  .map(
                    (r) => `
              <tr class="clickable-row" data-td-open-run="${r.id}">
                <td data-label="ID">#${r.id}</td>
                <td data-label="触发">${esc(r.trigger_type)}${r.simulate ? ' <span class="badge">模拟</span>' : ""}</td>
                <td data-label="状态">${statusBadge(r.status)}</td>
                <td data-label="新增 / 跳过">+${r.downloaded_count} / ${r.skipped_count}</td>
                <td data-label="耗时">${fmtDuration(r.duration_sec)}</td>
                <td data-label="时间">${fmtTime(r.created_at)}</td>
                <td data-label="操作"><a class="btn ghost sm" href="#/runs/${r.id}">日志与详情</a></td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="7" class="muted">尚无运行记录。</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function wireTaskForm(task = null) {
  const form = document.getElementById("task-edit-form");
  if (!form) return;
  upgradeSwitches(form);

  const srcModeEl = document.getElementById("td-source-mode");
  const urlsEl = document.getElementById("td-urls");
  const inputSel = document.getElementById("td-input-file");
  const cronEl = document.getElementById("td-cron");

  if (optionsApi) optionsApi.destroy();
  optionsApi = mountDownloadOptions(document.getElementById("td-options-slot"), {
    initial: task || {},
    getContext: () => ({
      task_id: task?.id || null,
      urls: srcModeEl.value === "urls" ? urlsEl.value : "",
      input_file: srcModeEl.value === "input_file" ? inputSel.value : "",
    }),
  });

  fetchInputOptions(task?.input_file || "");
  previewCronExpr();

  const debouncedEff = debounce(() => optionsApi?.refreshEffective(), 250);
  cronEl.addEventListener("input", debounce(previewCronExpr, 220));
  srcModeEl.addEventListener("change", () => {
    syncSourceMode();
    debouncedEff();
  });
  urlsEl.addEventListener("input", debouncedEff);
  inputSel.addEventListener("change", debouncedEff);

  form.addEventListener("click", async (e) => {
    const presetBtn = e.target.closest("[data-cron-preset]");
    if (presetBtn) {
      cronEl.value = presetBtn.dataset.cronPreset;
      previewCronExpr();
      return;
    }
    if (e.target.id === "td-refresh-inputs-btn") {
      await fetchInputOptions(inputSel.value);
      return;
    }
    if (e.target.id === "td-upload-btn") {
      const fileInput = document.getElementById("td-upload-file");
      const file = fileInput.files?.[0];
      if (!file) return showToast("请先选择要上传的 .txt 文件", "danger");
      try {
        const content = await file.text();
        const res = await api("/api/inputs/upload", { method: "POST", body: { filename: file.name, content } });
        fileInput.value = "";
        await fetchInputOptions(res.file.name);
        showToast(`已上传 ${res.file.name} (${res.file.url_count} 条 URL)`);
        debouncedEff();
      } catch (err) {
        showToast(err.message, "danger");
      }
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const opts = optionsApi.getValues();
    const srcMode = srcModeEl.value;
    const payload = {
      name: document.getElementById("td-name").value.trim(),
      cron_expr: cronEl.value.trim(),
      urls: srcMode === "urls" ? urlsEl.value : "",
      input_file: srcMode === "input_file" ? inputSel.value : "",
      notes: document.getElementById("td-notes").value.trim(),
      enabled: document.getElementById("td-enabled").checked,
      ...opts,
    };
    try {
      if (task?.id) {
        await api(`/api/tasks/${task.id}`, { method: "PUT", body: payload });
        showToast("任务设置已保存");
        await loadAndRender(task.id);
      } else {
        const res = await api("/api/tasks", { method: "POST", body: payload });
        showToast("任务已创建");
        navigate(`#/tasks/${res.task.id}`);
      }
    } catch (err) {
      showToast(err.message, "danger");
    }
  });
}

async function loadAndRender(taskId) {
  if (unmounted || !hostEl) return;

  if (!taskId) {
    hostEl.innerHTML = `
      <div class="page-head">
        <div>
          <div class="breadcrumbs"><a href="#/tasks">← 定时任务</a></div>
          <h1>新建定时任务</h1>
        </div>
      </div>
      ${renderSettingsForm(null)}
    `;
    wireTaskForm(null);
    return;
  }

  let detail;
  try {
    detail = await api(`/api/tasks/${taskId}`);
  } catch {
    detail = await loadTaskDetailFallback(taskId);
  }
  const sitesHealth = await getSitesHealth().catch(() => []);
  if (unmounted || !hostEl) return;

  const t = detail.task;
  const swClass = HAS_NATIVE_SWITCH ? "switch-ok" : "switch-ok switch-fallback";
  const overviewHtml = activeTab === "overview" ? await renderOverviewTab(detail, sitesHealth) : "";

  hostEl.innerHTML = `
    <div class="page-head">
      <div>
        <div class="breadcrumbs"><a href="#/tasks">← 定时任务</a><span>/</span><span>#${t.id}</span></div>
        <div class="row-actions">
          <h1>${esc(t.name)}</h1>
          ${t.last_status ? statusBadge(t.last_status) : ""}
        </div>
      </div>
      <div class="row-actions">
        <label class="switch-wrap">
          <input type="checkbox" switch role="switch" class="${swClass}" id="td-header-toggle" ${t.enabled ? "checked" : ""}>
          <span class="sm">${t.enabled ? "已启用" : "已停用"}</span>
        </label>
        <button type="button" class="btn primary sm" id="td-run-now-btn">立即执行</button>
        <button type="button" class="btn ghost sm" id="td-sim-btn">模拟试跑</button>
        <button type="button" class="btn danger sm" id="td-delete-btn">删除任务</button>
      </div>
    </div>

    <div class="subtabs" role="tablist" aria-label="任务页面标签">
      <button type="button" class="subtab-btn ${activeTab === "overview" ? "active" : ""}" role="tab" aria-selected="${activeTab === "overview"}" data-td-tab="overview">概览与历史</button>
      <button type="button" class="subtab-btn ${activeTab === "settings" ? "active" : ""}" role="tab" aria-selected="${activeTab === "settings"}" data-td-tab="settings">任务设置与生效配置</button>
    </div>

    <div id="td-tab-body">
      ${activeTab === "overview" ? overviewHtml : renderSettingsForm(t)}
    </div>
  `;

  if (activeTab === "settings") {
    wireTaskForm(t);
  }
}

export async function mount(el, params) {
  unmounted = false;
  hostEl = el;
  currentTaskId = params.id ? Number(params.id) : null;
  activeTab = currentTaskId ? "overview" : "settings";
  el.innerHTML = `<div class="notice muted">正在加载任务详情…</div>`;

  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  await loadAndRender(currentTaskId);
}

async function onChange(e) {
  if (e.target.id === "td-header-toggle" && currentTaskId) {
    try {
      await api(`/api/tasks/${currentTaskId}/toggle`, { method: "POST" });
      await loadAndRender(currentTaskId);
    } catch (err) {
      e.target.checked = !e.target.checked;
      showToast(err.message, "danger");
    }
  }
}

async function onClick(e) {
  const tabBtn = e.target.closest("[data-td-tab]");
  if (tabBtn && currentTaskId) {
    activeTab = tabBtn.dataset.tdTab;
    await loadAndRender(currentTaskId);
    return;
  }
  const btn = e.target.closest("button");
  if (btn && currentTaskId) {
    try {
      if (btn.id === "td-run-now-btn" || btn.id === "td-sim-btn") {
        const sim = btn.id === "td-sim-btn";
        const res = await api(`/api/tasks/${currentTaskId}/run`, { method: "POST", body: { simulate: sim } });
        showToast(res.already_active ? `任务已在执行中 (Run #${res.run_id})` : `已入队 Run #${res.run_id}`);
        navigate(`#/runs/${res.run_id}`);
      } else if (btn.id === "td-delete-btn") {
        const ok = await confirmDialog("删除定时任务", "确定删除此定时任务？历史运行记录仍会保留。", {
          confirmText: "删除",
          danger: true,
        });
        if (!ok) return;
        await api(`/api/tasks/${currentTaskId}`, { method: "DELETE" });
        showToast("任务已删除");
        navigate("#/tasks");
      }
    } catch (err) {
      showToast(err.message, "danger");
    }
    return;
  }
  if (e.target.closest("a")) return;
  const row = e.target.closest("tr[data-td-open-run]");
  if (row) navigate(`#/runs/${row.dataset.tdOpenRun}`);
}

export function onEvent(ev) {
  if (currentTaskId && activeTab === "overview" && ["run_queued", "run_started", "run_finished", "tasks_changed", "poll_tick"].includes(ev.type)) {
    loadAndRender(currentTaskId).catch(() => {});
  }
}

export function unmount() {
  unmounted = true;
  if (optionsApi) {
    optionsApi.destroy();
    optionsApi = null;
  }
  if (hostEl) {
    hostEl.removeEventListener("click", onClick);
    hostEl.removeEventListener("change", onChange);
  }
  hostEl = null;
}
