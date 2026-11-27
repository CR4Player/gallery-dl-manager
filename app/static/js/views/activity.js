import { api, getSitesHealth } from "../api.js";
import { navigate } from "../router.js";
import { syncSchedulerPill, syncVersionLine } from "../main.js";
import {
  debounce,
  esc,
  fmtDuration,
  fmtRelativeFuture,
  fmtRelativePast,
  fmtTime,
  showToast,
  statusBadge,
} from "../util.js";

let hostEl = null;
let unmounted = false;

async function renderActivity() {
  if (unmounted || !hostEl) return;
  const [dash, sites, tasksRes, alertsRes] = await Promise.all([
    api("/api/dashboard"),
    getSitesHealth().catch(() => []),
    api("/api/tasks").catch(() => ({ tasks: [] })),
    api("/api/alerts").catch(() => ({ items: [] })),
  ]);
  if (unmounted || !hostEl) return;

  syncSchedulerPill(dash.scheduler_paused);
  syncVersionLine(dash.versions);

  const s = dash.stats || {};
  const tasks = tasksRes.tasks || [];
  const failingTasks = tasks.filter((t) => Number(t.consecutive_failures || 0) > 0);
  const errorSites = (sites || []).filter((x) => x.health === "error");
  const notifFailures = (alertsRes.items || []).filter((a) => a.kind === "notification_error" && !a.read);

  const actionCards = [];
  for (const st of errorSites) {
    actionCards.push(`
      <article class="action-card">
        <div class="stack xs-gap">
          <div class="row-actions">
            ${statusBadge("auth_error")}
            <strong>站点 ${esc(st.site)} 认证失效</strong>
          </div>
          <div class="muted sm">${esc(st.last_auth_error_summary || "Cookie 或登录凭据可能已过期")} · ${fmtRelativePast(st.last_auth_error_at)}</div>
        </div>
        <div class="row-actions">
          <a class="btn danger sm" href="#/sites/${encodeURIComponent(st.site)}">更新 Cookie</a>
          ${st.last_auth_error_run_id ? `<a class="btn sm" href="#/runs/${st.last_auth_error_run_id}">查看失败日志</a>` : ""}
        </div>
      </article>
    `);
  }
  for (const t of failingTasks) {
    actionCards.push(`
      <article class="action-card warn">
        <div class="stack xs-gap">
          <div class="row-actions">
            ${statusBadge(t.last_status || "failed")}
            <strong>任务「${esc(t.name)}」连续异常 ${t.consecutive_failures} 次</strong>
          </div>
          <div class="muted sm">上次执行：${fmtTime(t.last_run_at)}</div>
        </div>
        <div class="row-actions">
          <a class="btn sm" href="#/tasks/${t.id}">查看任务</a>
          <button type="button" class="btn primary sm" data-act-run-task="${t.id}">立即重试</button>
        </div>
      </article>
    `);
  }
  if (notifFailures.length) {
    const first = notifFailures[0];
    actionCards.push(`
      <article class="action-card warn">
        <div class="stack xs-gap">
          <div class="row-actions">
            <span class="badge failed">通知失败</span>
            <strong>${esc(first.title)}（共 ${notifFailures.length} 条未读）</strong>
          </div>
          <div class="muted sm">${esc(first.detail)}</div>
        </div>
        <div class="row-actions">
          <a class="btn sm" href="#/settings/notifications">检查通知配置</a>
        </div>
      </article>
    `);
  }

  const activeHtml = dash.active_runs?.length
    ? dash.active_runs
        .map(
          (r) => `
        <div class="notice info banner-row">
          <div>
            <div class="row-actions">${statusBadge(r.status, "status-pill")} <strong>#${r.id} ${esc(r.task_name)}</strong></div>
            <div class="muted sm">+${r.downloaded_count} 新增 · ${r.skipped_count} 跳过 · 耗时 ${fmtDuration(r.duration_sec)}</div>
          </div>
          <div class="row-actions">
            <a class="btn sm" href="#/runs/${r.id}">实时日志</a>
            <button type="button" class="btn danger sm" data-act-cancel-run="${r.id}">中止</button>
          </div>
        </div>`
        )
        .join("")
    : `<div class="notice sm muted">当前空闲 · 队列无等待或运行中任务</div>`;

  const upcoming = dash.upcoming_tasks || [];
  let upcomingHtml = "";
  if (dash.scheduler_paused) {
    upcomingHtml = `<div class="notice warn banner-row"><span class="sm">全局定时调度当前已暂停，可在右上角胶囊恢复。</span><a class="btn sm" href="#/tasks">管理任务</a></div>`;
  } else if (!upcoming.length) {
    upcomingHtml = `<div class="notice banner-row"><span class="muted sm">暂无已启用的定时任务。</span><a class="btn sm" href="#/tasks">前往配置</a></div>`;
  } else {
    upcomingHtml = upcoming
      .map(
        (t) => `
      <div class="upcoming-item">
        <div>
          <div class="row-actions">
            <a href="#/tasks/${t.id}"><strong>${esc(t.name)}</strong></a>
            <span class="badge">${esc(fmtRelativeFuture(t.next_run_at))}</span>
          </div>
          <div class="muted sm">${fmtTime(t.next_run_at)} · ${esc(t.cron_desc)}</div>
        </div>
        <button type="button" class="btn sm" data-act-run-task="${t.id}">立即执行</button>
      </div>`
      )
      .join("");
  }

  const st = dash.storage_summary || {};
  const recentRows = dash.recent_runs || [];

  hostEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1>动态</h1>
        <p class="muted sm" style="margin:0.2rem 0 0;">当前队列状态、待处理异常与近期抓取活动</p>
      </div>
      <div class="row-actions">
        <button type="button" class="btn sm" id="act-refresh-btn">刷新</button>
      </div>
    </div>

    ${dash.legacy_import_notice ? `
      <div class="notice warn banner-row">
        <div>
          <strong>已导入原容器配置，定时任务当前为暂停状态</strong>
          <div class="muted sm">为避免与仍在运行的旧版 <code>gallery-dl</code> 容器并发抢写，导入的定时任务默认未启用。确认停止旧容器后，可在此一键全部启用。</div>
        </div>
        <div class="row-actions">
          <button type="button" class="btn primary sm" id="act-enable-all-btn">一键启用全部任务</button>
          <button type="button" class="btn ghost sm" id="act-dismiss-legacy-btn">知道了</button>
        </div>
      </div>` : ""}

    <div class="stats-grid">
      <div class="card stat-card"><span class="muted sm">运行中 / 排队</span><strong>${s.running_count ?? 0} / ${s.queued_count ?? 0}</strong></div>
      <div class="card stat-card"><span class="muted sm">今日新增文件</span><strong>${s.today_downloaded ?? 0}</strong></div>
      <div class="card stat-card"><span class="muted sm">近 7 天新增</span><strong>${s.week_downloaded ?? 0}</strong></div>
      <div class="card stat-card"><span class="muted sm">已启用定时任务</span><strong>${s.task_enabled ?? 0} / ${s.task_total ?? 0}</strong></div>
    </div>

    ${actionCards.length ? `
      <section class="stack sm-gap">
        <h2 style="margin:0; font-size:1.05rem;">需要处理 (${actionCards.length})</h2>
        <div class="action-cards">${actionCards.join("")}</div>
      </section>` : ""}

    <div class="two-col">
      <section class="card">
        <div class="card-head">
          <h2>正在运行与排队</h2>
          <a class="btn sm" href="#/runs">全部记录</a>
        </div>
        <div class="stack sm-gap">${activeHtml}</div>

        <h3 class="subhead">存档与列表概览</h3>
        <div class="mini-stats-grid">
          <a class="mini-stat" href="#/settings/integrations">
            <span class="muted sm">Archive 去重库</span>
            <strong>${st.archive_entries ?? 0} 条</strong>
          </a>
          <a class="mini-stat" href="#/settings/integrations">
            <span class="muted sm">Twitter 红心 ID</span>
            <strong>${st.twitter_sync_ids ?? 0} 条</strong>
          </a>
          <a class="mini-stat" href="#/settings/integrations">
            <span class="muted sm">NAS 输入列表</span>
            <strong>${st.input_files_count ?? 0} 个</strong>
          </a>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>即将执行的定时任务</h2>
          <a class="btn sm" href="#/tasks">管理任务</a>
        </div>
        <div class="stack sm-gap">${upcomingHtml}</div>
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>最近抓取记录</h2>
        <a class="btn sm" href="#/runs">查看全部</a>
      </div>
      <div tabindex="0" role="region" aria-labelledby="act-runs-cap" class="table-wrapper">
        <table class="data-table">
          <caption id="act-runs-cap" class="visually-hidden">最近抓取运行记录</caption>
          <thead>
            <tr>
              <th>ID</th>
              <th>任务</th>
              <th>触发</th>
              <th>状态</th>
              <th>新增 / 跳过</th>
              <th>耗时</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${recentRows.length ? recentRows.map((r) => `
              <tr class="clickable-row" data-act-open-run="${r.id}">
                <td data-label="ID">#${r.id}</td>
                <td data-label="任务"><strong>${esc(r.task_name)}</strong>${r.simulate ? ' <span class="badge">模拟</span>' : ""}</td>
                <td data-label="触发">${esc(r.trigger_type)}</td>
                <td data-label="状态">${statusBadge(r.status)}</td>
                <td data-label="新增 / 跳过">+${r.downloaded_count} / ${r.skipped_count}</td>
                <td data-label="耗时">${fmtDuration(r.duration_sec)}</td>
                <td data-label="时间">${fmtTime(r.created_at)}</td>
                <td data-label="操作"><a class="btn ghost sm" href="#/runs/${r.id}">详情</a></td>
              </tr>`).join("") : `<tr><td colspan="8" class="muted">暂无运行记录。</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

const debouncedRefresh = debounce(() => renderActivity().catch(() => {}), 250);

export async function mount(el) {
  unmounted = false;
  hostEl = el;
  el.innerHTML = `<div class="notice muted">正在加载动态…</div>`;

  el.addEventListener("click", onClick);
  await renderActivity();
}

async function onClick(e) {
  const btn = e.target.closest("button");
  if (btn) {
    try {
      if (btn.id === "act-refresh-btn") {
        await renderActivity();
      } else if (btn.id === "act-enable-all-btn") {
        await api("/api/tasks/enable-all", { method: "POST" });
        showToast("已启用全部定时任务");
        await renderActivity();
      } else if (btn.id === "act-dismiss-legacy-btn") {
        await api("/api/tasks/dismiss-import-notice", { method: "POST" });
        await renderActivity();
      } else if (btn.dataset.actCancelRun) {
        await api(`/api/runs/${btn.dataset.actCancelRun}/cancel`, { method: "POST" });
        showToast("已发送中止信号");
        await renderActivity();
      } else if (btn.dataset.actRunTask) {
        const res = await api(`/api/tasks/${btn.dataset.actRunTask}/run`, { method: "POST", body: { simulate: false } });
        showToast(res.already_active ? `任务已在执行中 (Run #${res.run_id})` : `已入队 Run #${res.run_id}`);
        navigate(`#/runs/${res.run_id}`);
      }
    } catch (err) {
      showToast(err.message, "danger");
    }
    return;
  }

  if (e.target.closest("a")) return;
  const row = e.target.closest("tr[data-act-open-run]");
  if (row) {
    navigate(`#/runs/${row.dataset.actOpenRun}`);
  }
}

export function onEvent(ev) {
  if (["run_queued", "run_started", "run_finished", "scheduler", "tasks_changed", "alerts_changed", "poll_tick"].includes(ev.type)) {
    debouncedRefresh();
  }
}

export function unmount() {
  unmounted = true;
  if (hostEl) hostEl.removeEventListener("click", onClick);
  hostEl = null;
}
