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
    const [dash, healthRes] = await Promise.all([
      api.get("/api/dashboard"),
      api.get("/health", { noAuthRedirect: true }).catch(() => null),
    ]);
    if (destroyed) return;

    const kpis = dash?.kpis || dash?.stats || {};
    const activeRuns = dash?.active_runs || dash?.running_runs || [];
    const queuedRuns = dash?.queued_runs || [];
    const liveQueue = [...activeRuns, ...queuedRuns];
    const recentRuns = dash?.recent_runs || [];
    const upcoming = dash?.upcoming_tasks || dash?.next_tasks || [];
    const insights = dash?.insights || dash?.recommendations || [];
    const siteHealth = dash?.site_health || dash?.sites_summary || [];
    const notice = dash?.import_notice || dash?.migration_notice;
    const historyBars = dash?.trend || dash?.daily_stats || [];

    const page = el("div", { class: "stack" });

    // Page header
    page.appendChild(
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          null,
          el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.35rem" } }, "动态总览"),
          el("div", { class: "muted xs" }, "调度队列、运行趋势、异常处理建议与站点健康状态")
        ),
        el(
          "div",
          { class: "row-actions" },
          el("button", { type: "button", class: "fl-btn sm", onClick: loadAndRender }, "刷新状态"),
          el("button", { type: "button", class: "fl-btn accent sm", onClick: () => ctx?.openNewDownload?.() }, "+ 新建下载")
        )
      )
    );

    // Optional legacy import notice banner
    if (notice && (notice.show || notice.pending_count > 0)) {
      page.appendChild(
        el(
          "div",
          { class: "fl-infobar warn" },
          el(
            "div",
            { style: { flex: 1 } },
            el("strong", null, notice.title || "检测到已迁移原容器定时任务"),
            el("div", { class: "xs muted" }, notice.message || `共有 ${notice.pending_count || ""} 个待确认任务，默认为暂停状态以避免与旧容器冲突。`)
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

    // 4 KPI Cards
    const runningCount = kpis.running_count ?? healthRes?.running_count ?? activeRuns.length;
    const queuedCount = kpis.queued_count ?? healthRes?.queued_count ?? queuedRuns.length;
    const todayFiles = kpis.today_downloaded ?? kpis.downloaded_today ?? 0;
    const weekFiles = kpis.week_downloaded ?? kpis.downloaded_7d ?? 0;
    const enabledTasks = kpis.enabled_tasks ?? 0;
    const totalTasks = kpis.total_tasks ?? 0;

    page.appendChild(
      el(
        "div",
        { class: "stats-grid" },
        el(
          "div",
          { class: "fl-stat-card" },
          el("span", { class: "fl-stat-label" }, "运行中 / 排队"),
          el("strong", null, `${runningCount} / ${queuedCount}`),
          el("div", { class: "muted xs" }, healthRes?.scheduler_paused ? "全局调度已暂停" : "自动调度运行中")
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
          historyBars.length
            ? el(
                "div",
                { class: "health-bars", style: { marginTop: "0.25rem" }, title: "近 7 天下载活跃度" },
                ...historyBars.slice(-14).map((b) =>
                  el("span", {
                    class: `health-bar ${b.status || (b.failed > 0 ? "partial" : "success")}`,
                    title: `${b.date || ""}: +${b.downloaded || b.count || 0}`,
                  })
                )
              )
            : el("div", { class: "muted xs" }, "持续累积媒体档案")
        ),
        el(
          "div",
          { class: `fl-stat-card${enabledTasks === 0 && totalTasks > 0 ? " warn" : ""}` },
          el("span", { class: "fl-stat-label" }, "已启用定时任务"),
          el("strong", null, `${enabledTasks} / ${totalTasks}`),
          el("div", { class: "muted xs" }, "支持任务级代理与后处理")
        )
      )
    );

    // Insights / actionable recommendations
    if (insights.length) {
      const insCard = el(
        "section",
        { class: "fl-card stack sm-gap" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, `待处理异常 (${insights.length})`)
      );
      for (const ins of insights) {
        const sevCls = ins.severity === "error" ? "danger" : ins.severity === "warn" ? "warn" : "info";
        const targetRoute = ins.site
          ? `#site/${encodeURIComponent(ins.site)}`
          : ins.task_id
            ? `#task/${ins.task_id}`
            : ins.run_id
              ? `#runs/${ins.run_id}`
              : null;
        insCard.appendChild(
          el(
            "div",
            { class: `fl-infobar ${sevCls}` },
            el(
              "div",
              { style: { flex: 1 } },
              el("strong", { class: "sm" }, ins.title || ins.kind || "需要关注"),
              ins.message ? el("div", { class: "xs muted" }, ins.message) : null
            ),
            targetRoute
              ? el(
                  "button",
                  {
                    type: "button",
                    class: "fl-btn sm",
                    onClick: () => navigate(targetRoute),
                  },
                  ins.action_label || (ins.site ? "去处理凭据" : "查看详情")
                )
              : null
          )
        );
      }
      page.appendChild(insCard);
    }

    // Main 2-column grid
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
    if (!liveQueue.length) {
      queueCard.appendChild(el("div", { class: "empty-state" }, "当前没有正在运行或排队中的下载任务"));
    } else {
      for (const r of liveQueue) {
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
                el("a", { href: `#runs/${r.id}`, class: "sm", style: { fontWeight: 600 } }, `#${r.id} ${r.task_name || r.label || "即时下载"}`)
              ),
              el("div", { class: "muted xs" }, `已下载 +${r.files_downloaded ?? 0} · 跳过 ${r.files_skipped ?? 0} · ${fmtTimeShort(r.started_at || r.created_at)}`)
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
              el("div", { class: "muted xs" }, `Cron: ${t.cron_expr} · 下次执行 ${relTime(t.next_run_at)}`)
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
              el("span", { class: "run-item-title" }, `#${r.id} ${r.task_name || r.label || "下载任务"}`),
              statusBadge(r.status)
            ),
            el(
              "div",
              { class: "run-item-meta" },
              `+${r.files_downloaded ?? 0} 新增 · ${r.files_skipped ?? 0} 跳过 · ${fmtDuration(r.duration_seconds)} · ${fmtTimeShort(r.created_at)}`
            )
          )
        );
      }
    }
    rightCol.appendChild(recentCard);

    // Site health card
    if (Array.isArray(siteHealth) && siteHealth.length) {
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
          { class: "row-actions", style: { gap: "0.45rem" } },
          ...siteHealth.map((s) =>
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
