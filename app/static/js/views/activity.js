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
import { pageHead, cardHead, statCard, infoBar, emptyState } from "../ui.js";
import { icon } from "../icons.js";

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

    const page = el("div", { class: "page-body" });

    page.appendChild(
      pageHead({
        eyebrow: "Control Center",
        title: "动态总览",
        subtitle: `Archive 去重条目 ${storage.archive_entries ?? 0} · Twitter 红心库 ${storage.twitter_sync_ids ?? 0} · NAS 列表 ${storage.input_files_count ?? 0}`,
        actions: [
          el("button", { type: "button", class: "fl-btn sm", onClick: loadAndRender }, icon("refresh", 14), "刷新状态"),
          el("button", { type: "button", class: "fl-btn accent sm", onClick: () => ctx?.openNewDownload?.() }, icon("plus", 14), "新建下载"),
        ],
      })
    );

    if (dash?.legacy_import_notice) {
      page.appendChild(
        infoBar({
          tone: "warn",
          title: "已导入初始定时任务（默认暂停）",
          body: "为避免与旧容器同时争抢 Cookie 或写入目录，导入的任务默认处于暂停状态；确认旧容器已停用后可一键启用。",
          actions: [
            el(
              "button",
              {
                type: "button",
                class: "fl-btn accent sm",
                onClick: async () => {
                  try {
                    await api.post("/api/tasks/enable-all", {});
                    toast("已启用全部定时任务");
                    await ctx?.refreshHeader?.();
                    loadAndRender();
                  } catch (err) {
                    toast(`启用失败：${err.message}`, "danger");
                  }
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
                  try {
                    await api.post("/api/tasks/dismiss-import-notice", {});
                    loadAndRender();
                  } catch (err) {
                    toast(`操作失败：${err.message}`, "danger");
                  }
                },
              },
              "知道了"
            ),
          ],
        })
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
        statCard({
          label: "运行中 / 排队",
          value: `${runningCount} / ${queuedCount}`,
          hint: dash?.scheduler_paused ? "全局调度已暂停" : "自动调度运行中",
          iconName: "activity",
        }),
        statCard({
          label: "今日新增文件",
          value: String(todayFiles),
          hint: "已自动去重并校验",
          tone: "ok",
          iconName: "download",
        }),
        statCard({
          label: "近 7 天累计入库",
          value: String(weekFiles),
          iconName: "database",
          extra: recentRuns.length
            ? el(
                "span",
                { class: "health-bars", title: "近期运行结果趋势" },
                ...recentRuns.slice(0, 12).reverse().map((r) =>
                  el("span", {
                    class: `health-bar ${r.status}`,
                    title: `#${r.id} ${r.task_name}: +${r.downloaded_count ?? 0}`,
                  })
                )
              )
            : null,
          hint: recentRuns.length ? "" : "持续累积媒体档案",
        }),
        statCard({
          label: "已启用定时任务",
          value: `${enabledTasks} / ${totalTasks}`,
          hint: stats.task_failing > 0 ? `${stats.task_failing} 个任务近期存在异常` : "全部任务状态正常",
          tone: stats.task_failing > 0 ? "warn" : "",
          iconName: "calendar",
        })
      )
    );

    if (recentAlerts.length) {
      const alertRows = recentAlerts.slice(0, 4).map((r) => {
        const tone = r.status === "partial" ? "warn" : "danger";
        return el(
          "div",
          { class: "fl-sub-card row-actions between", style: { alignItems: "center" } },
          el(
            "div",
            { class: "row-actions", style: { minWidth: 0, flex: 1 } },
            el("span", { class: `health-dot ${tone === "warn" ? "warn" : "error"}`, style: { flex: "none" } }),
            el(
              "div",
              { class: "stack xs-gap", style: { minWidth: 0 } },
              el("strong", { class: "sm" }, `#${r.id} ${r.task_name}`),
              el("span", { class: "muted xs" }, r.error_summary || r.error_category || `状态：${r.status}`)
            )
          ),
          el(
            "button",
            { type: "button", class: "fl-btn sm", onClick: () => navigate(`#runs/${r.id}`) },
            icon("file-text", 14),
            "查看日志"
          )
        );
      });

      page.appendChild(
        el(
          "section",
          { class: "fl-card stack sm-gap" },
          cardHead(`近期异常运行 (${recentAlerts.length})`, { iconName: "alert", subtitle: "需要关注的失败、认证失效或部分失败记录" }),
          ...alertRows
        )
      );
    }

    const leftCol = el("div", { class: "dashboard-col" });
    const rightCol = el("div", { class: "dashboard-col" });

    // Live / queued card
    const queueCard = el(
      "section",
      { class: "fl-card stack" },
      cardHead("正在运行与等待队列", {
        iconName: "zap",
        subtitle: activeRuns.length ? `${activeRuns.length} 个活动任务` : "空闲",
        actions: [el("a", { class: "fl-btn subtle xs", href: "#runs" }, "全部记录", icon("chevron-right", 13))],
      })
    );
    if (!activeRuns.length) {
      queueCard.appendChild(emptyState("当前没有正在运行或排队中的下载任务", "zap", "队列空闲"));
    } else {
      for (const r of activeRuns) {
        queueCard.appendChild(
          el(
            "div",
            { class: "upcoming-item" },
            el(
              "div",
              { class: "row-actions", style: { minWidth: 0, flex: 1 } },
              statusBadge(r.status),
              el(
                "div",
                { class: "stack xs-gap", style: { minWidth: 0 } },
                el("a", { href: `#runs/${r.id}`, class: "task-name" }, `#${r.id} ${r.task_name || "即时下载"}`),
                el(
                  "span",
                  { class: "muted xs" },
                  `已下载 +${r.downloaded_count ?? 0} · 跳过 ${r.skipped_count ?? 0} · ${fmtTimeShort(r.started_at || r.created_at)}`
                )
              )
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn danger xs",
                onClick: async () => {
                  const ok = await confirmModal({ title: "中止运行", message: `确定中止 Run #${r.id} 吗？`, okText: "中止", danger: true });
                  if (!ok) return;
                  try {
                    await api.post(`/api/runs/${r.id}/cancel`, {});
                    toast(`已请求中止 Run #${r.id}`);
                    loadAndRender();
                  } catch (err) {
                    toast(`中止失败：${err.message}`, "danger");
                  }
                },
              },
              icon("pause", 13),
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
      { class: "fl-card stack" },
      cardHead("即将执行的定时任务", {
        iconName: "clock",
        subtitle: "按 Cron 自动触发",
        actions: [el("a", { class: "fl-btn subtle xs", href: "#tasks" }, "管理任务", icon("chevron-right", 13))],
      })
    );
    if (!upcoming.length) {
      upCard.appendChild(emptyState("暂无已启用的定时任务", "calendar", "没有排程"));
    } else {
      for (const t of upcoming.slice(0, 6)) {
        upCard.appendChild(
          el(
            "div",
            { class: "upcoming-item" },
            el(
              "div",
              { class: "stack xs-gap", style: { minWidth: 0, flex: 1 } },
              el("a", { href: `#task/${t.id}`, class: "task-name" }, t.name || `任务 #${t.id}`),
              el("span", { class: "muted xs" }, `${t.cron_desc || t.cron_expr} · 下次执行 ${relTime(t.next_run_at)}`)
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn sm",
                onClick: async () => {
                  try {
                    const res = await api.post(`/api/tasks/${t.id}/run`, { simulate: false });
                    if (res?.already_active) {
                      toast(`任务已在运行或排队中 (Run #${res.run_id})`);
                    } else {
                      toast(res?.run_id ? `已触发运行 #${res.run_id}` : "已加入队列");
                    }
                    loadAndRender();
                  } catch (err) {
                    toast(`触发失败：${err.message}`, "danger");
                  }
                },
              },
              icon("play", 13),
              "立即运行"
            )
          )
        );
      }
    }
    leftCol.appendChild(upCard);

    // Recent runs
    const recentCard = el(
      "section",
      { class: "fl-card stack" },
      cardHead("最近运行结果", {
        iconName: "terminal",
        actions: [el("a", { class: "fl-btn subtle xs", href: "#runs" }, "完整记录", icon("chevron-right", 13))],
      })
    );
    if (!recentRuns.length) {
      recentCard.appendChild(emptyState("暂无历史运行记录", "terminal", "还没有运行数据"));
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
              el("span", null, `+${r.downloaded_count ?? 0} 新增`),
              el("span", null, "·"),
              el("span", null, `${r.skipped_count ?? 0} 跳过`),
              el("span", null, "·"),
              el("span", null, fmtDuration(r.duration_sec)),
              el("span", null, "·"),
              el("span", null, fmtTimeShort(r.created_at))
            )
          )
        );
      }
    }
    rightCol.appendChild(recentCard);

    // Site health
    if (siteHealth.length) {
      rightCol.appendChild(
        el(
          "section",
          { class: "fl-card stack" },
          cardHead("站点凭据健康状态", {
            iconName: "shield",
            subtitle: "Cookie 与登录态的最新探测结果",
            actions: [el("a", { class: "fl-btn subtle xs", href: "#sites" }, "站点配置", icon("chevron-right", 13))],
          }),
          el(
            "div",
            { class: "site-health-grid" },
            ...siteHealth.slice(0, 8).map((s) =>
              el(
                "a",
                { class: "site-health-chip", href: `#site/${encodeURIComponent(s.site)}` },
                el("span", { class: `health-dot ${s.health || "unknown"}` }),
                el("span", null, SITE_LABELS[s.site] || s.site),
                healthBadge(s.health)
              )
            )
          )
        )
      );
    }

    page.appendChild(el("div", { class: "dashboard-grid" }, leftCol, rightCol));
    container.replaceChildren(page);
  }

  await loadAndRender();

  const onEvt = () => {
    if (!destroyed) loadAndRender().catch(() => {});
  };
  const unsubs = [
    events.on("scheduler", onEvt),
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
