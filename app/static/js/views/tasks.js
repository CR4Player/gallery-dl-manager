import { api } from "../api.js";
import { navigate } from "../router.js";
import {
  clearPopoverFallbackStyles,
  confirmDialog,
  debounce,
  esc,
  fmtTime,
  HAS_NATIVE_SWITCH,
  positionPopoverFallback,
  showToast,
  statusBadge,
} from "../util.js";

let hostEl = null;
let unmounted = false;
let tasks = [];
let batchMode = false;
const selectedIds = new Set();
let searchQuery = "";
let filterMode = "all";

function filterTasks(list) {
  const q = searchQuery.trim().toLowerCase();
  return list.filter((t) => {
    if (filterMode === "enabled" && !t.enabled) return false;
    if (filterMode === "disabled" && t.enabled) return false;
    if (filterMode === "failing" && Number(t.consecutive_failures || 0) === 0) return false;
    if (q) {
      const hay = [t.name, t.input_file, ...(t.urls || []), ...(t.sites || [])].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderSparkline(recentStatuses = []) {
  if (!recentStatuses.length) return `<span class="muted xs">暂无运行</span>`;
  return `
    <div class="health-bars" aria-label="最近运行趋势">
      ${recentStatuses
        .map(
          (r) =>
            `<a class="health-bar ${esc(r.status)}" href="#/runs/${r.id}" title="#${r.id} · ${esc(r.status)} · +${r.downloaded_count ?? 0}"></a>`
        )
        .join("")}
    </div>
  `;
}

function syncBatchUI(visible) {
  const bar = document.getElementById("tasks-batch-bar");
  const th = document.getElementById("tasks-batch-th");
  const toggleBtn = document.getElementById("tasks-batch-toggle-btn");
  if (!bar || !th || !toggleBtn) return;

  bar.classList.toggle("hidden", !batchMode);
  th.classList.toggle("hidden", !batchMode);
  toggleBtn.textContent = batchMode ? "完成批量管理" : "批量管理";

  const visibleIds = visible.map((t) => t.id);
  const selectedVisible = visibleIds.filter((id) => selectedIds.has(id)).length;
  const selectAll = document.getElementById("tasks-select-all");
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
  const cntEl = document.getElementById("tasks-batch-count");
  if (cntEl) cntEl.textContent = `已选 ${selectedIds.size} 项`;
  hostEl?.querySelectorAll("[data-batch-action]").forEach((b) => {
    b.disabled = selectedIds.size === 0;
  });
}

function renderTable() {
  const tbody = document.getElementById("tasks-tbody");
  if (!tbody) return;
  const validIds = new Set(tasks.map((t) => t.id));
  for (const id of [...selectedIds]) {
    if (!validIds.has(id)) selectedIds.delete(id);
  }
  const visible = filterTasks(tasks);
  syncBatchUI(visible);

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="${batchMode ? 6 : 5}" class="muted">${tasks.length ? "没有符合筛选条件的任务。" : "暂无定时任务，点击右上角「＋ 新建任务」。"}</td></tr>`;
    return;
  }

  const swClass = HAS_NATIVE_SWITCH ? "task-switch" : "task-switch switch-fallback";
  tbody.innerHTML = visible
    .map(
      (t) => `
    <tr>
      <td class="batch-col ${batchMode ? "" : "hidden"}" data-label="选择">
        <input type="checkbox" class="checkbox-custom" data-select-task="${t.id}" ${selectedIds.has(t.id) ? "checked" : ""} aria-label="选择任务 ${esc(t.name)}">
      </td>
      <td data-label="任务名称">
        <div class="row-actions" style="gap:0.4rem;">
          <a href="#/tasks/${t.id}"><strong>${esc(t.name)}</strong></a>
          ${(t.sites || []).map((s) => `<span class="badge">${esc(s)}</span>`).join("")}
        </div>
        <div class="muted sm">${t.input_file ? `输入文件：<code>${esc(t.input_file)}</code>` : esc((t.urls || []).slice(0, 2).join(" · "))}${(t.urls || []).length > 2 ? ` 等 ${t.urls.length} 条` : ""}</div>
      </td>
      <td data-label="启用状态">
        <label class="switch-wrap">
          <input type="checkbox" switch role="switch" class="${swClass}" data-toggle-task="${t.id}" ${t.enabled ? "checked" : ""} aria-label="启用定时任务 ${esc(t.name)}">
          <span class="sm ${t.enabled ? "" : "muted"}">${t.enabled ? "已启用" : "已停用"}</span>
        </label>
        ${t.consecutive_failures > 0 ? `<div class="xs" style="color:var(--danger); margin-top:0.2rem;">连续异常 ${t.consecutive_failures} 次</div>` : ""}
      </td>
      <td data-label="调度计划">
        <code>${esc(t.cron_expr)}</code>
        <div class="muted sm">${esc(t.cron_desc)}</div>
        ${t.next_runs?.length ? `<div class="muted xs">下次：${fmtTime(t.next_runs[0])}</div>` : ""}
      </td>
      <td data-label="最近执行">
        <div class="stack xs-gap">
          ${renderSparkline(t.recent_statuses)}
          <div class="row-actions" style="gap:0.35rem;">
            ${t.last_status ? statusBadge(t.last_status) : '<span class="muted xs">尚未运行</span>'}
            <span class="muted xs">${fmtTime(t.last_run_at)}</span>
          </div>
        </div>
      </td>
      <td data-label="操作">
        <div class="row-actions">
          <button type="button" class="btn primary sm" data-run-task="${t.id}">立即执行</button>
          <button type="button" class="btn ghost sm icon-btn" popovertarget="task-menu-${t.id}" style="anchor-name: --tm-${t.id}" aria-label="更多操作 (${esc(t.name)})">⋯</button>
          <div id="task-menu-${t.id}" popover="auto" class="action-popover" style="position-anchor: --tm-${t.id}">
            <button type="button" class="popover-item" data-sim-task="${t.id}">模拟试跑</button>
            <button type="button" class="popover-item" data-goto-task="${t.id}">查看 / 编辑设置</button>
            <button type="button" class="popover-item danger" data-delete-task="${t.id}">删除任务</button>
          </div>
        </div>
      </td>
    </tr>`
    )
    .join("");
}

async function fetchAndRender() {
  const data = await api("/api/tasks");
  if (unmounted) return;
  tasks = data.tasks || [];
  renderTable();
}

const debouncedReload = debounce(() => fetchAndRender().catch(() => {}), 250);

export async function mount(el) {
  unmounted = false;
  hostEl = el;
  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>定时任务</h1>
        <p class="muted sm" style="margin:0.2rem 0 0;">查看近期健康走势、启停调度，点开任务名称可管理详情与继承配置</p>
      </div>
      <div class="row-actions">
        <button type="button" class="btn" id="tasks-batch-toggle-btn">批量管理</button>
        <a class="btn primary" href="#/tasks/new">＋ 新建任务</a>
      </div>
    </div>

    <div class="card stack">
      <div class="filter-bar">
        <input type="search" id="tasks-search" value="${esc(searchQuery)}" placeholder="搜索任务名、URL 或站点…" aria-label="搜索定时任务">
        <div class="chip-group" role="group" aria-label="按状态过滤">
          <button type="button" class="chip-btn" data-task-filter="all" aria-pressed="${filterMode === "all"}">全部</button>
          <button type="button" class="chip-btn" data-task-filter="enabled" aria-pressed="${filterMode === "enabled"}">已启用</button>
          <button type="button" class="chip-btn" data-task-filter="disabled" aria-pressed="${filterMode === "disabled"}">已停用</button>
          <button type="button" class="chip-btn" data-task-filter="failing" aria-pressed="${filterMode === "failing"}">连续异常</button>
        </div>
      </div>

      <div id="tasks-batch-bar" class="batch-bar hidden">
        <div class="row-actions">
          <label class="checkbox-inline"><input type="checkbox" class="checkbox-custom" id="tasks-select-all"> 全选</label>
          <span id="tasks-batch-count" class="muted sm">已选 0 项</span>
        </div>
        <div class="row-actions">
          <button type="button" class="btn sm" data-batch-action="enable">批量启用</button>
          <button type="button" class="btn sm" data-batch-action="disable">批量停用</button>
          <button type="button" class="btn danger sm" data-batch-action="delete">批量删除</button>
          <button type="button" class="btn ghost sm" id="tasks-batch-exit-btn">退出多选</button>
        </div>
      </div>

      <div tabindex="0" role="region" aria-labelledby="tasks-cap" class="table-wrapper">
        <table class="data-table">
          <caption id="tasks-cap" class="visually-hidden">定时抓取任务列表</caption>
          <thead>
            <tr>
              <th id="tasks-batch-th" class="batch-col hidden">选择</th>
              <th>任务名称</th>
              <th>启用状态</th>
              <th>调度计划 (Cron)</th>
              <th>近 10 次健康度与最近运行</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="tasks-tbody">
            <tr><td colspan="5" class="muted">正在加载任务…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  el.addEventListener("input", onInput);
  el.addEventListener("change", onChange);
  el.addEventListener("click", onClick);
  el.addEventListener("toggle", onPopoverToggle, true);

  await fetchAndRender();
}

function onInput(e) {
  if (e.target.id === "tasks-search") {
    searchQuery = e.target.value;
    renderTable();
  }
}

async function onChange(e) {
  const input = e.target;
  if (input.id === "tasks-select-all") {
    const visible = filterTasks(tasks);
    if (input.checked) visible.forEach((t) => selectedIds.add(t.id));
    else visible.forEach((t) => selectedIds.delete(t.id));
    renderTable();
  } else if (input.dataset?.selectTask) {
    const id = Number(input.dataset.selectTask);
    if (input.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    syncBatchUI(filterTasks(tasks));
  } else if (input.dataset?.toggleTask) {
    const id = input.dataset.toggleTask;
    try {
      await api(`/api/tasks/${id}/toggle`, { method: "POST" });
      await fetchAndRender();
    } catch (err) {
      input.checked = !input.checked;
      showToast(err.message, "danger");
    }
  }
}

function onPopoverToggle(e) {
  const pop = e.target;
  if (!pop.classList?.contains("action-popover")) return;
  if (e.newState !== "open") {
    clearPopoverFallbackStyles(pop);
    return;
  }
  const trigger = hostEl?.querySelector(`[popovertarget="${pop.id}"]`);
  if (trigger) positionPopoverFallback(pop, trigger);
}

async function onClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.classList.contains("popover-item")) {
    btn.closest("[popover]")?.hidePopover?.();
  }

  try {
    if (btn.id === "tasks-batch-toggle-btn") {
      batchMode = !batchMode;
      if (!batchMode) selectedIds.clear();
      renderTable();
    } else if (btn.id === "tasks-batch-exit-btn") {
      batchMode = false;
      selectedIds.clear();
      renderTable();
    } else if (btn.dataset.taskFilter) {
      filterMode = btn.dataset.taskFilter;
      hostEl.querySelectorAll("[data-task-filter]").forEach((b) => {
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      });
      renderTable();
    } else if (btn.dataset.batchAction) {
      const action = btn.dataset.batchAction;
      const ids = [...selectedIds];
      if (!ids.length) return;
      if (action === "delete") {
        const ok = await confirmDialog("批量删除任务", `确定删除选中的 ${ids.length} 个定时任务？历史运行记录仍会保留。`, {
          confirmText: "删除",
          danger: true,
        });
        if (!ok) return;
      }
      const res = await api("/api/tasks/batch", { method: "POST", body: { action, task_ids: ids } });
      const verb = action === "enable" ? "启用" : action === "disable" ? "停用" : "删除";
      showToast(`已批量${verb} ${res.affected} 个任务`);
      if (action === "delete") selectedIds.clear();
      await fetchAndRender();
    } else if (btn.dataset.runTask || btn.dataset.simTask) {
      const tid = btn.dataset.runTask || btn.dataset.simTask;
      const sim = Boolean(btn.dataset.simTask);
      const res = await api(`/api/tasks/${tid}/run`, { method: "POST", body: { simulate: sim } });
      showToast(res.already_active ? `任务已在执行中 (Run #${res.run_id})` : `已入队 Run #${res.run_id}`);
      navigate(`#/runs/${res.run_id}`);
    } else if (btn.dataset.gotoTask) {
      navigate(`#/tasks/${btn.dataset.gotoTask}`);
    } else if (btn.dataset.deleteTask) {
      const ok = await confirmDialog("删除定时任务", "确定删除此定时任务？历史运行记录仍会保留。", {
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      await api(`/api/tasks/${btn.dataset.deleteTask}`, { method: "DELETE" });
      showToast("任务已删除");
      await fetchAndRender();
    }
  } catch (err) {
    showToast(err.message, "danger");
  }
}

export function onEvent(ev) {
  if (["tasks_changed", "run_finished", "poll_tick"].includes(ev.type)) {
    debouncedReload();
  }
}

export function unmount() {
  unmounted = true;
  if (hostEl) {
    hostEl.removeEventListener("input", onInput);
    hostEl.removeEventListener("change", onChange);
    hostEl.removeEventListener("click", onClick);
    hostEl.removeEventListener("toggle", onPopoverToggle, true);
  }
  hostEl = null;
}
