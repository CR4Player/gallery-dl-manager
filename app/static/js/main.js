import { api, invalidateSharedCache } from "./api.js";
import { initNewDownloadDrawer } from "./components/new-download.js";
import { onGlobalEvent, startEvents } from "./events.js";
import { getActiveView, navigate, registerRoute, startRouter } from "./router.js";
import {
  clearPopoverFallbackStyles,
  esc,
  fmtTime,
  positionPopoverFallback,
  showToast,
  statusBadge,
} from "./util.js";

const alertsState = {
  items: [],
  unread: 0,
};

function renderAlertsBadge() {
  const badge = document.getElementById("alerts-unread-badge");
  if (!badge) return;
  if (alertsState.unread <= 0) {
    badge.classList.add("hidden");
    badge.textContent = "0";
  } else {
    badge.textContent = alertsState.unread > 99 ? "99+" : String(alertsState.unread);
    badge.classList.remove("hidden");
  }
}

function renderAlertsPopover() {
  renderAlertsBadge();
  const listEl = document.getElementById("alerts-pop-list");
  const countEl = document.getElementById("alerts-pop-count");
  if (countEl) {
    countEl.textContent = alertsState.items.length
      ? `(未读 ${alertsState.unread} / 共 ${alertsState.items.length})`
      : "";
  }
  if (!listEl) return;
  if (!alertsState.items.length) {
    listEl.innerHTML = `<div class="muted sm" style="padding:1rem; text-align:center;">暂无异常告警或失败通知。</div>`;
    return;
  }
  listEl.innerHTML = alertsState.items
    .map((a) => {
      const firstSite = a.sites?.[0] || "";
      const fixBtn =
        a.status === "auth_error" && firstSite
          ? `<button type="button" class="btn danger xs" data-alert-fix-site="${esc(firstSite)}" data-alert-key="${esc(a.alert_key)}">更新 Cookie</button>`
          : "";
      return `
      <div class="alert-row ${a.read ? "" : "unread"}">
        <div style="flex:1; min-width:0;">
          <button type="button" class="alert-row-main" data-alert-jump="${esc(a.alert_key)}" data-alert-run="${a.run_id ?? ""}" data-alert-view="${esc(a.target_view)}">
            <div class="run-item-top">${statusBadge(a.status, "status-pill")} <strong>${esc(a.title)}</strong></div>
            <div class="alert-detail">${esc(a.detail)}</div>
            <div class="muted xs">${fmtTime(a.created_at)}</div>
          </button>
          ${fixBtn ? `<div style="margin-top:0.35rem;">${fixBtn}</div>` : ""}
        </div>
        <div class="alert-row-actions">
          ${!a.read ? `<button type="button" class="btn ghost xs" data-alert-read="${esc(a.alert_key)}" title="标为已读">已读</button>` : ""}
          <button type="button" class="btn ghost xs" data-alert-clear="${esc(a.alert_key)}" aria-label="清除此条通知" title="清除">✕</button>
        </div>
      </div>`;
    })
    .join("");
}

export async function refreshAlerts() {
  try {
    const data = await api("/api/alerts");
    alertsState.items = data.items || [];
    alertsState.unread = Number(data.unread_count || 0);
    renderAlertsPopover();
  } catch {}
}

export function syncSchedulerPill(paused) {
  const pill = document.getElementById("scheduler-pill");
  if (!pill) return;
  pill.textContent = paused ? "调度已暂停" : "调度运行中";
  pill.classList.toggle("paused", Boolean(paused));
  pill.classList.toggle("running", !paused);
  pill.dataset.paused = paused ? "1" : "0";
}

export function syncVersionLine(versions) {
  const el = document.getElementById("version-line");
  if (!el || !versions) return;
  el.textContent = `gallery-dl ${versions.gallery_dl || "?"} · exiftool ${versions.exiftool || "?"}`;
}

function initThemeSync() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const apply = () => {
    let saved = null;
    try {
      saved = localStorage.getItem("color-scheme");
    } catch {}
    meta.content = saved === "light" || saved === "dark" ? saved : "light dark";
  };
  window.addEventListener("storage", (e) => {
    if (e.key === "color-scheme") apply();
  });
  apply();
}

function bindTopbarEvents() {
  document.getElementById("scheduler-pill")?.addEventListener("click", async (e) => {
    const paused = e.currentTarget.dataset.paused === "1";
    try {
      const res = await api(paused ? "/api/scheduler/resume" : "/api/scheduler/pause", { method: "POST" });
      syncSchedulerPill(res.scheduler_paused);
      showToast(res.scheduler_paused ? "定时调度已暂停" : "定时调度已恢复");
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  document.getElementById("alerts-read-all-btn")?.addEventListener("click", async () => {
    const res = await api("/api/alerts/read", { method: "POST", body: { all: true } });
    alertsState.items = res.items || [];
    alertsState.unread = Number(res.unread_count || 0);
    renderAlertsPopover();
  });

  document.getElementById("alerts-clear-all-btn")?.addEventListener("click", async () => {
    const res = await api("/api/alerts/clear", { method: "POST", body: { all: true } });
    alertsState.items = res.items || [];
    alertsState.unread = Number(res.unread_count || 0);
    renderAlertsPopover();
  });

  document.body.addEventListener(
    "toggle",
    (e) => {
      const pop = e.target;
      if (!pop.classList?.contains("action-popover") && !pop.classList?.contains("alerts-popover")) return;
      if (e.newState !== "open") {
        clearPopoverFallbackStyles(pop);
        return;
      }
      if (pop.id === "alerts-popover") refreshAlerts();
      const trigger = document.querySelector(`[popovertarget="${pop.id}"]`);
      if (trigger) positionPopoverFallback(pop, trigger);
    },
    true
  );

  document.getElementById("alerts-popover")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.alertFixSite) {
      const key = btn.dataset.alertKey;
      if (key) api("/api/alerts/read", { method: "POST", body: { alert_key: key } }).catch(() => {});
      document.getElementById("alerts-popover")?.hidePopover?.();
      navigate(`#/sites/${encodeURIComponent(btn.dataset.alertFixSite)}`);
      return;
    }
    if (btn.dataset.alertJump) {
      const key = btn.dataset.alertJump;
      const runId = btn.dataset.alertRun;
      const targetView = btn.dataset.alertView || "runs";
      api("/api/alerts/read", { method: "POST", body: { alert_key: key } })
        .then((res) => {
          alertsState.items = res.items || [];
          alertsState.unread = Number(res.unread_count || 0);
          renderAlertsPopover();
        })
        .catch(() => {});
      document.getElementById("alerts-popover")?.hidePopover?.();
      if (runId) navigate(`#/runs/${runId}`);
      else if (targetView === "notifications") navigate("#/settings/notifications");
      else navigate("#/runs");
    } else if (btn.dataset.alertRead) {
      const res = await api("/api/alerts/read", { method: "POST", body: { alert_key: btn.dataset.alertRead } });
      alertsState.items = res.items || [];
      alertsState.unread = Number(res.unread_count || 0);
      renderAlertsPopover();
    } else if (btn.dataset.alertClear) {
      const res = await api("/api/alerts/clear", { method: "POST", body: { alert_key: btn.dataset.alertClear } });
      alertsState.items = res.items || [];
      alertsState.unread = Number(res.unread_count || 0);
      renderAlertsPopover();
    }
  });
}

function registerAppRoutes() {
  registerRoute("/", () => import("./views/activity.js"));
  registerRoute("/tasks", () => import("./views/tasks.js"));
  registerRoute("/tasks/new", () => import("./views/task-detail.js"));
  registerRoute("/tasks/:id", () => import("./views/task-detail.js"));
  registerRoute("/runs", () => import("./views/runs.js"));
  registerRoute("/runs/:id", () => import("./views/runs.js"));
  registerRoute("/sites", () => import("./views/sites.js"));
  registerRoute("/sites/new", () => import("./views/site-detail.js"));
  registerRoute("/sites/:name", () => import("./views/site-detail.js"));
  registerRoute("/settings", () => import("./views/settings.js"));
  registerRoute("/settings/:section", () => import("./views/settings.js"));
}

async function bootstrap() {
  initThemeSync();
  bindTopbarEvents();
  initNewDownloadDrawer();
  registerAppRoutes();

  onGlobalEvent((ev) => {
    if (ev.type === "hello") {
      syncSchedulerPill(ev.scheduler_paused);
      alertsState.unread = Number(ev.unread_alerts_count || 0);
      renderAlertsBadge();
    } else if (ev.type === "scheduler") {
      syncSchedulerPill(ev.paused);
    } else if (ev.type === "config_changed") {
      invalidateSharedCache();
    } else if (ev.type === "run_finished" || ev.type === "alerts_changed") {
      invalidateSharedCache();
      refreshAlerts();
    }

    const view = getActiveView();
    if (view?.onEvent) {
      try {
        view.onEvent(ev);
      } catch {}
    }
  });

  startEvents();
  refreshAlerts();
  api("/health")
    .then((h) => {
      syncSchedulerPill(h.scheduler_paused);
      syncVersionLine(h.versions);
    })
    .catch(() => {});

  await startRouter();
}

bootstrap();
