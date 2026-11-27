import { api } from "../api.js";
import { events } from "../events.js";
import {
  el,
  toast,
  confirmModal,
  statusBadge,
  healthBadge,
  fmtTimeShort,
  fmtDuration,
  relTime,
  SITE_LABELS,
} from "../util.js";
import { navigate } from "../router.js";

export async function renderActivity(container, _route, ctx) {
  let destroyed = false;

  async function loadAndRender() {
    const [dash, healthRes, sitesRes] = await Promise.all([
      api.get("/api/dashboard"),
      api.get("/health", { noAuthRedirect: true }).catch(() => null),
      api.get("/api/sites/health").catch(() => null),
    ]);
    if (destroyed) return;

    const stats = dash?.stats || {};
    const activeRuns = Array.isArray(dash?.active_runs) ? dash.active_runs : [];
    const recentRuns = Array.isArray(dash?.recent_runs) ? dash.recent_runs : [];
    const recentAlerts = Array.isArray(dash?.recent_alerts) ? dash.recent_alerts : [];
    const upcoming = Array.isArray(dash?.upcoming_tasks) ? dash.upcoming_tasks : [];
    const storage = dash?.storage_summary || {};
    const siteHealth = Array.isArray(sitesRes?.sites) ? sitesRes.sites : [];

    const page = el("div", { class: "stack" });

    page.appendChild(
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          null,
          el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.35rem" } }, "动态总览"),
          el(
            "div",
            { class: "muted xs" },
            `Archive 去重条目 ${storage.archive_entries ?? 0} · Twitter 红心库 ${storage.twitter_sync_ids ?? 0} · NAS 列表 ${storage.input_files_count ?? 0}`
          )
        ),
        el(
          "div",
          { class: "row-actions" },
          el("button", { type: "button", class: "fl-btn sm", onClick: loadAndRender }, "刷新状态"),
          el("button", { type: "button", class: "fl-btn accent sm", onClick: () => ctx?.openNewDownload?.() }, "+ 新建下载")
        )
      )
    );

    if (dash?.legacy_import_notice) {
      page.appendChild(
        el(
          "div",
          { class: "fl-infobar warn" },
          el(
            "div",
            { style: { flex: 1 } },
            el("strong", null, "已导入初始定时任务（默认暂停）"),
            el("div", { class: "xs muted" }, "为避免与旧容器同时争抢 Cookie 或写入目录，导入的任务默认处于暂停状态；确认旧容器已停用后可一键启用。")
          ),
          el(
            "div",
            { class: "row-actions" },
            el(
              "button",
              {
                type: "button",
                class: "fl-btn accent sm",
                onClick: async () => {
                  await api.post("/api/tasks/enable-all", {});
                  toast("已启用全部定时任务");
                  await ctx?.refreshHeader?.();
                  loadAndRender();
                },
              },
              "一键启用全部"
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn subtle sm",
                onClick: async () => {
                  await api.post("/api/tasks/dismiss-import-notice", {});
                  loadAndRender();
                },
              },
              "知道了"
            )
          )
        )
      );
    }

    const runningCount = stats.running_count ?? healthRes?.running_count ?? 0;
    const queuedCount = stats.queued_count ?? healthRes?.queued_count ?? 0;
    const todayFiles = stats.today_downloaded ?? 0;
    const weekFiles = stats.week_downloaded ?? 0;
    const enabledTasks = stats.task_enabled ?? 0;
    const totalTasks = stats.task_total ?? 0;

    page.appendChild(
      el(
        "div",
        { class: "stats-grid" },
        el(
          "div",
          { class: "fl-stat-card" },
          el("span", { class: "fl-stat-label" }, "运行中 / 排队"),
          el("strong", null, `${runningCount} / ${queuedCount}`),
          el("div", { class: "muted xs" }, dash?.scheduler_paused ? "全局调度已暂停" : "自动调度运行中")
        ),
        el(
          "div",
          { class: "fl-stat-card ok" },
          el("span", { class: "fl-stat-label" }, "今日新增文件"),
          el("strong", null, String(todayFiles)),
          el("div", { class: "muted xs" }, "已自动去重并校验")
        ),
        el(
          "div",
          { class: "fl-stat-card" },
          el("span", { class: "fl-stat-label" }, "近 7 天累计入库"),
          el("strong", null, String(weekFiles)),
          recentRuns.length
            ? el(
                "div",
                { class: "health-bars", style: { marginTop: "0.25rem" }, title: "近期运行结果趋势" },
                ...recentRuns.slice(0, 12).reverse().map((r) =>
                  el("span", {
                    class: `health-bar ${r.status}`,
                    title: `#${r.id} ${r.task_name}: +${r.downloaded_count ?? 0}`,
                  })
                )
              )
            : el("div", { class: "muted xs" }, "持续累积媒体档案")
        ),
        el(
          "div",
          { class: `fl-stat-card${stats.task_failing > 0 ? " warn" : ""}` },
          el("span", { class: "fl-stat-label" }, "已启用定时任务"),
          el("strong", null, `${enabledTasks} / ${totalTasks}`),
          el("div", { class: "muted xs" }, stats.task_failing > 0 ? `${stats.task_failing} 个任务近期存在异常` : "全部任务状态正常")
        )
      )
    );

    if (recentAlerts.length) {
      const insCard = el(
        "section",
        { class: "fl-card stack sm-gap" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, `近期异常运行 (${recentAlerts.length})`)
      );
      for (const r of recentAlerts.slice(0, 4)) {
        const sevCls = r.status === "partial" ? "warn" : "danger";
        insCard.appendChild(
          el(
            "div",
            { class: `fl-infobar ${sevCls}` },
            el(
              "div",
              { style: { flex: 1 } },
              el("strong", { class: "sm" }, `#${r.id} ${r.task_name}`),
              el("div", { class: "xs muted" }, r.error_summary || r.error_category || `状态：${r.status}`)
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn sm",
                onClick: () => navigate(`#runs/${r.id}`),
              },
              "查看日志"
            )
          )
        );
      }
      page.appendChild(insCard);
    }

    const leftCol = el("div", { class: "stack" });
    const rightCol = el("div", { class: "stack" });

    // Live / Queued card
    const queueCard = el(
      "section",
      { class: "fl-card stack sm-gap" },
      el(
        "div",
        { class: "row-actions between" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "正在运行与等待队列"),
        el("a", { class: "fl-btn subtle xs", href: "#runs" }, "查看全部记录 →")
      )
    );
    if (!activeRuns.length) {
      queueCard.appendChild(el("div", { class: "empty-state" }, "当前没有正在运行或排队中的下载任务"));
    } else {
      for (const r of activeRuns) {
        queueCard.appendChild(
          el(
            "div",
            { class: "fl-sub-card row-actions between" },
            el(
              "div",
              { class: "stack xs-gap", style: { minWidth: 0, flex: 1 } },
              el(
                "div",
                { class: "row-actions xs-gap" },
                statusBadge(r.status),
                el("a", { href: `#runs/${r.id}`, class: "sm", style: { fontWeight: 600 } }, `#${r.id} ${r.task_name || "即时下载"}`)
              ),
              el("div", { class: "muted xs" }, `已下载 +${r.downloaded_count ?? 0} · 跳过 ${r.skipped_count ?? 0} · ${fmtTimeShort(r.started_at || r.created_at)}`)
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn danger xs",
                onClick: async () => {
                  const ok = await confirmModal({ title: "中止运行", message: `确定中止 Run #${r.id} 吗？`, okText: "中止", danger: true });
                  if (!ok) return;
                  await api.post(`/api/runs/${r.id}/cancel`, {});
                  toast(`已请求中止 Run #${r.id}`);
                  loadAndRender();
                },
              },
              "中止"
            )
          )
        );
      }
    }
    leftCol.appendChild(queueCard);

    // Upcoming scheduled tasks
    const upCard = el(
      "section",
      { class: "fl-card stack sm-gap" },
      el(
        "div",
        { class: "row-actions between" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "即将执行定时任务"),
        el("a", { class: "fl-btn subtle xs", href: "#tasks" }, "管理任务 →")
      )
    );
    if (!upcoming.length) {
      upCard.appendChild(el("div", { class: "empty-state" }, "暂无已启用的定时任务"));
    } else {
      for (const t of upcoming.slice(0, 6)) {
        upCard.appendChild(
          el(
            "div",
            { class: "fl-sub-card row-actions between" },
            el(
              "div",
              { style: { minWidth: 0, flex: 1 } },
              el("a", { href: `#task/${t.id}`, class: "sm", style: { fontWeight: 600 } }, t.name || `任务 #${t.id}`),
              el("div", { class: "muted xs" }, `${t.cron_desc || t.cron_expr} · 下次执行 ${relTime(t.next_run_at)}`)
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn sm",
                onClick: async () => {
                  const res = await api.post(`/api/tasks/${t.id}/run`, { simulate: false });
                  toast(res?.run_id ? `已触发运行 #${res.run_id}` : "已加入队列");
                  loadAndRender();
                },
              },
              "立即运行"
            )
          )
        );
      }
    }
    leftCol.appendChild(upCard);

    // Recent runs card
    const recentCard = el(
      "section",
      { class: "fl-card stack sm-gap" },
      el(
        "div",
        { class: "row-actions between" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "最近运行结果"),
        el("a", { class: "fl-btn subtle xs", href: "#runs" }, "完整记录 →")
      )
    );
    if (!recentRuns.length) {
      recentCard.appendChild(el("div", { class: "empty-state" }, "暂无历史运行记录"));
    } else {
      for (const r of recentRuns.slice(0, 7)) {
        recentCard.appendChild(
          el(
            "a",
            { class: "run-item", href: `#runs/${r.id}` },
            el(
              "div",
              { class: "run-item-top" },
              el("span", { class: "run-item-title" }, `#${r.id} ${r.task_name || "下载任务"}`),
              statusBadge(r.status)
            ),
            el(
              "div",
              { class: "run-item-meta" },
              `+${r.downloaded_count ?? 0} 新增 · ${r.skipped_count ?? 0} 跳过 · ${fmtDuration(r.duration_sec)} · ${fmtTimeShort(r.created_at)}`
            )
          )
        );
      }
    }
    rightCol.appendChild(recentCard);

    // Site health card
    if (siteHealth.length) {
      const shCard = el(
        "section",
        { class: "fl-card stack sm-gap" },
        el(
          "div",
          { class: "row-actions between" },
          el("h2", { class: "fl-card-title", style: { margin: 0 } }, "站点凭据健康状态"),
          el("a", { class: "fl-btn subtle xs", href: "#sites" }, "站点配置 →")
        ),
        el(
          "div",
          { class: "row-actions", style: { gap: "0.45rem", flexWrap: "wrap" } },
          ...siteHealth.slice(0, 8).map((s) =>
            el(
              "a",
              { class: "fl-btn sm", href: `#site/${encodeURIComponent(s.site)}` },
              el("span", { class: `health-dot ${s.health || "unknown"}` }),
              el("span", null, SITE_LABELS[s.site] || s.site),
              healthBadge(s.health)
            )
          )
        )
      );
      rightCol.appendChild(shCard);
    }

    page.appendChild(el("div", { class: "two-col" }, leftCol, rightCol));
    container.replaceChildren(page);
  }

  await loadAndRender();

  const onEvt = () => {
    if (!destroyed) loadAndRender().catch(() => {});
  };
  const unsubs = [
    events.on("run_queued", onEvt),
    events.on("run_started", onEvt),
    events.on("run_finished", onEvt),
    events.on("tasks_changed", onEvt),
    events.on("alerts_changed", onEvt),
  ];

  return () => {
    destroyed = true;
    unsubs.forEach((u) => u());
  };
}
