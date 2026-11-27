import { api } from "./api.js";
import { events } from "./events.js";
import { el, toast, confirmModal, positionPopoverFallback, SITE_LABELS } from "./util.js";
import { startRouter, navigate, parseHash } from "./router.js";
import { openDownloadDrawer } from "./components/new-download.js";

import { renderActivity } from "./views/activity.js";
import { renderTasks } from "./views/tasks.js";
import { renderTaskDetail } from "./views/task-detail.js";
import { renderRuns } from "./views/runs.js";
import { renderSites } from "./views/sites.js";
import { renderSiteDetail } from "./views/site-detail.js";
import { renderSettings } from "./views/settings.js";

const VIEWS = {
  activity: renderActivity,
  tasks: renderTasks,
  "task-detail": renderTaskDetail,
  runs: renderRuns,
  sites: renderSites,
  "site-detail": renderSiteDetail,
  settings: renderSettings,
};

let activeCleanup = null;
let alertsState = { items: [], unread_count: 0 };
let authDisabled = true;

function initThemeControls() {
  const group = document.getElementById("theme-switcher");
  if (!group) return;
  const buttons = [...group.querySelectorAll("button[data-theme]")];
  const meta = document.querySelector('meta[name="color-scheme"]');

  const applyTheme = (mode) => {
    const val = mode === "light" || mode === "dark" ? mode : "system";
    const resolved = val === "system" ? "light dark" : val;
    if (meta) meta.content = resolved;
    document.documentElement.style.colorScheme = resolved;
    for (const btn of buttons) {
      btn.setAttribute("aria-pressed", String(btn.dataset.theme === val));
    }
  };

  const saved = localStorage.getItem("gdl-theme") || "system";
  applyTheme(saved);

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.theme || "system";
      localStorage.setItem("gdl-theme", next);
      applyTheme(next);
    });
  }
}

function initNavCollapse() {
  const shell = document.getElementById("fl-shell");
  const toggleBtn = document.getElementById("fl-pane-toggle");
  if (!shell || !toggleBtn) return;

  const saved = localStorage.getItem("gdl-nav-collapsed") === "1";
  if (saved) {
    shell.dataset.collapsed = "1";
    toggleBtn.setAttribute("aria-expanded", "false");
  }

  toggleBtn.addEventListener("click", () => {
    const next = shell.dataset.collapsed !== "1";
    if (next) {
      shell.dataset.collapsed = "1";
      localStorage.setItem("gdl-nav-collapsed", "1");
    } else {
      delete shell.dataset.collapsed;
      localStorage.removeItem("gdl-nav-collapsed");
    }
    toggleBtn.setAttribute("aria-expanded", String(!next));
  });
}

function updateNavActive(navName) {
  document.querySelectorAll("[data-nav]").forEach((node) => {
    const matched = node.dataset.nav === navName;
    if (matched) {
      node.setAttribute("aria-current", "page");
    } else {
      node.removeAttribute("aria-current");
    }
  });
}

function renderSchedulerPill(paused, runningCount = 0, queuedCount = 0) {
  const pill = document.getElementById("scheduler-pill");
  const text = document.getElementById("scheduler-pill-text");
  if (!pill || !text) return;
  pill.dataset.paused = paused ? "1" : "0";
  pill.classList.toggle("paused", Boolean(paused));
  pill.classList.toggle("running", !paused);
  if (paused) {
    text.textContent = "调度已暂停";
  } else if (runningCount > 0 || queuedCount > 0) {
    text.textContent = `运行中 ${runningCount} · 排队 ${queuedCount}`;
  } else {
    text.textContent = "调度运行中";
  }
}

async function refreshHealthAndTasksBadge() {
  try {
    const [health, tasksRes] = await Promise.all([
      api.get("/health", { noAuthRedirect: true }),
      api.get("/api/tasks").catch(() => null),
    ]);
    const verLine = document.getElementById("version-line");
    if (verLine && health?.versions) {
      const gdl = health.versions.gallery_dl || "unknown";
      const exif = health.versions.exiftool || "unknown";
      verLine.textContent = `gallery-dl ${gdl} · exiftool ${exif}`;
    }
    renderSchedulerPill(health?.scheduler_paused, health?.running_count, health?.queued_count);

    const badge = document.getElementById("nav-badge-tasks");
    if (badge && tasksRes) {
      const list = tasksRes.tasks || tasksRes.items || (Array.isArray(tasksRes) ? tasksRes : []);
      const enabledCount = list.filter((t) => t.enabled).length;
      if (list.length > 0) {
        badge.textContent = String(enabledCount);
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }
  } catch {
    // Ignore transient health errors; views will report actionable failures.
  }
}

function resolveAlertAction(alert) {
  if (!alert) return null;
  if (alert.action?.route) return alert.action;
  if (alert.site) {
    return {
      label: alert.kind === "auth_error" ? "更新凭据" : "查看站点",
      route: `#site/${encodeURIComponent(alert.site)}`,
    };
  }
  if (alert.run_id) {
    return { label: "查看日志", route: `#runs/${alert.run_id}` };
  }
  if (alert.task_id) {
    return { label: "查看任务", route: `#task/${alert.task_id}` };
  }
  return null;
}

function renderAlertsUI() {
  const badge = document.getElementById("alerts-unread-badge");
  const countText = document.getElementById("alerts-pop-count");
  const listEl = document.getElementById("alerts-pop-list");
  if (!listEl) return;

  const items = alertsState.items || [];
  const unread = alertsState.unread_count ?? items.filter((a) => !a.read_at && !a.read).length;

  if (badge) {
    badge.textContent = String(unread);
    badge.classList.toggle("hidden", unread <= 0);
  }
  if (countText) {
    countText.textContent = unread > 0 ? ` (${unread} 条未读)` : ` (${items.length} 条)`;
  }

  listEl.innerHTML = "";
  if (!items.length) {
    listEl.appendChild(el("div", { class: "empty-state xs" }, "暂无异常与通知记录"));
    return;
  }

  for (const a of items) {
    const isUnread = !a.read_at && !a.read;
    const severityCls = a.severity === "error" || a.level === "error" ? "err" : a.severity === "warn" || a.level === "warning" ? "warn" : "info";
    const severityLabel = a.kind === "auth_error" ? "认证失效" : severityCls === "err" ? "异常" : severityCls === "warn" ? "警告" : "提示";
    const act = resolveAlertAction(a);
    const siteLabel = a.site ? SITE_LABELS[a.site] || a.site : "";

    const row = el(
      "div",
      { class: `fl-alert-card${isUnread ? " unread" : ""}` },
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          { class: "row-actions xs-gap" },
          el("span", { class: `fl-badge ${severityCls}` }, severityLabel),
          el("strong", { class: "sm" }, a.title || (siteLabel ? `${siteLabel} 异常` : "系统通知"))
        ),
        el("button", {
          type: "button",
          class: "fl-btn subtle xs",
          title: "删除此通知",
          "aria-label": "删除此通知",
          onClick: async (e) => {
            e.stopPropagation();
            await api.post("/api/alerts/clear", { alert_key: a.alert_key || a.key || a.id });
            await refreshAlerts();
          },
        }, "✕")
      ),
      a.detail || a.message ? el("div", { class: "muted xs" }, a.detail || a.message) : null,
      act
        ? el(
            "div",
            { class: "row-actions", style: { marginTop: "0.2rem" } },
            el("button", {
              type: "button",
              class: `fl-btn xs${severityCls === "err" ? " danger" : ""}`,
              onClick: async () => {
                if (isUnread) {
                  await api.post("/api/alerts/read", { alert_key: a.alert_key || a.key || a.id }).catch(() => {});
                }
                document.getElementById("alerts-popover")?.hidePopover?.();
                navigate(act.route);
              },
            }, act.label)
          )
        : null
    );
    listEl.appendChild(row);
  }
}

async function refreshAlerts() {
  try {
    const res = await api.get("/api/alerts");
    alertsState = {
      items: res?.alerts || res?.items || [],
      unread_count: res?.unread_count ?? 0,
    };
    renderAlertsUI();
  } catch {
    // Non-fatal
  }
}

function initHeaderActions() {
  const openDownload = () => openDownloadDrawer();
  document.getElementById("open-download-btn")?.addEventListener("click", openDownload);
  document.getElementById("open-download-btn-mobile")?.addEventListener("click", openDownload);

  const schedBtn = document.getElementById("scheduler-pill");
  schedBtn?.addEventListener("click", async () => {
    const isPaused = schedBtn.dataset.paused === "1";
    const ok = await confirmModal({
      title: isPaused ? "恢复全局自动调度" : "暂停全局自动调度",
      message: isPaused
        ? "恢复后，所有已启用的定时任务将按 Cron 表达式继续自动触发。"
        : "暂停后，新触发的定时任务将跳过执行（正在运行中的任务和手动即时下载不受影响）。",
      okText: isPaused ? "恢复调度" : "暂停调度",
      danger: !isPaused,
    });
    if (!ok) return;
    try {
      await api.post(isPaused ? "/api/scheduler/resume" : "/api/scheduler/pause", {});
      toast(isPaused ? "全局自动调度已恢复" : "全局自动调度已暂停");
      await refreshHealthAndTasksBadge();
    } catch (err) {
      toast(`操作失败：${err.message}`, "danger");
    }
  });

  const bellBtn = document.getElementById("alerts-bell-btn");
  const popEl = document.getElementById("alerts-popover");
  if (popEl && bellBtn) {
    popEl.addEventListener("toggle", (e) => {
      if (e.newState === "open") {
        refreshAlerts();
        positionPopoverFallback(popEl, bellBtn);
      }
    });
  }

  document.getElementById("alerts-read-all-btn")?.addEventListener("click", async () => {
    await api.post("/api/alerts/read", { all: true }).catch(() => {});
    await refreshAlerts();
  });

  document.getElementById("alerts-clear-all-btn")?.addEventListener("click", async () => {
    await api.post("/api/alerts/clear", { all: true }).catch(() => {});
    await refreshAlerts();
  });

  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    try {
      await api.post("/api/auth/logout", {});
    } catch {
      // ignore
    }
    location.replace("/login");
  });
}

async function mountRoute(route) {
  const main = document.getElementById("app-main");
  if (!main) return;
  updateNavActive(route.nav);

  if (typeof activeCleanup === "function") {
    try {
      activeCleanup();
    } catch {
      // ignore cleanup error
    }
    activeCleanup = null;
  }

  const renderer = VIEWS[route.view] || renderActivity;
  main.innerHTML = "";
  main.appendChild(el("div", { class: "fl-infobar" }, "正在载入页面内容…"));

  try {
    const cleanup = await renderer(main, route, {
      refreshHeader: async () => {
        await Promise.all([refreshHealthAndTasksBadge(), refreshAlerts()]);
      },
      openNewDownload: openDownloadDrawer,
      authDisabled: () => authDisabled,
    });
    activeCleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (err) {
    main.innerHTML = "";
    main.appendChild(
      el(
        "div",
        { class: "fl-infobar danger" },
        el("strong", null, "页面加载失败："),
        el("span", null, err?.message || "未知错误"),
        el("button", {
          type: "button",
          class: "fl-btn sm",
          style: { marginInlineStart: "auto" },
          onClick: () => mountRoute(parseHash(location.hash)),
        }, "重试")
      )
    );
  }
}

async function bootstrap() {
  initThemeControls();
  initNavCollapse();
  initHeaderActions();

  try {
    const status = await api.get("/api/auth/status", { noAuthRedirect: true });
    authDisabled = Boolean(status?.auth_disabled);
    if (!authDisabled && !status?.authenticated) {
      location.replace(status?.configured ? "/login" : "/setup");
      return;
    }
    document.getElementById("logout-btn")?.classList.toggle("hidden", authDisabled);
  } catch {
    // Allow fallback views to surface backend connection issues if /api/auth/status fails.
  }

  events.start();
  events.on("scheduler", () => refreshHealthAndTasksBadge());
  events.on("run_queued", () => refreshHealthAndTasksBadge());
  events.on("run_started", () => refreshHealthAndTasksBadge());
  events.on("run_finished", () => {
    refreshHealthAndTasksBadge();
    refreshAlerts();
  });
  events.on("tasks_changed", () => refreshHealthAndTasksBadge());
  events.on("alerts_changed", () => refreshAlerts());

  await Promise.all([refreshHealthAndTasksBadge(), refreshAlerts()]);
  startRouter(mountRoute);
}

bootstrap();
