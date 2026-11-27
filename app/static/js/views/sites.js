import { getSitesHealth } from "../api.js";
import { esc, fmtRelativePast, healthBadge, statusBadge } from "../util.js";

let hostEl = null;
let unmounted = false;

async function renderSites() {
  if (unmounted || !hostEl) return;
  const sites = await getSitesHealth(true);
  if (unmounted || !hostEl) return;

  const cardsHtml = sites.length
    ? sites
        .map((s) => {
          const authSummary = (s.auth_fields || [])
            .map((a) => `<code>${esc(a.key)}=${esc(a.masked)}</code>`)
            .join(" ");
          const cookieChips = (s.cookie_keys || [])
            .slice(0, 6)
            .map((k) => `<span class="ov-source-tag">${esc(k)}</span>`)
            .join("");
          const taskLinks = (s.task_ids || [])
            .map((tid, idx) => `<a class="badge" href="#/tasks/${tid}">${esc(s.task_names?.[idx] || `#${tid}`)}</a>`)
            .join(" ");

          return `
        <article class="card site-card">
          <div class="stack sm-gap">
            <div class="row-actions between">
              <div class="row-actions">
                <strong style="font-size:1.08rem;">${esc(s.site)}</strong>
                ${healthBadge(s.health)}
              </div>
              ${!s.configured ? `<span class="badge">未建配置</span>` : ""}
            </div>

            <div class="muted xs">域名：${(s.domains || []).map((d) => `<code>${esc(d)}</code>`).join(" · ")}</div>

            ${s.health === "error" ? `
              <div class="notice danger sm">
                最近认证失效（${fmtRelativePast(s.last_auth_error_at)}）：${esc(s.last_auth_error_summary || "Cookie 已过期")}
              </div>` : ""}

            <div class="stack xs-gap sm">
              <div>
                <span class="muted">Cookies：</span>
                <strong>${s.cookie_count} 项</strong>
                ${cookieChips ? `<div class="cookie-chips" style="margin-top:0.25rem;">${cookieChips}${s.cookie_keys.length > 6 ? `<span class="muted xs">+${s.cookie_keys.length - 6}</span>` : ""}</div>` : ""}
              </div>
              <div>
                <span class="muted">其他凭据：</span>
                ${authSummary || `<span class="muted">无</span>`}
              </div>
              <div>
                <span class="muted">ExifTool 后处理：</span>
                ${s.postprocess_enabled
                  ? `<span class="badge success">${s.postprocess_config?.mode === "custom" ? "自定义" : "内置"}</span>`
                  : `<span class="muted">未开启</span>`}
              </div>
              <div>
                <span class="muted">关联任务：</span>
                ${taskLinks || `<span class="muted">暂无关联任务</span>`}
              </div>
              ${s.last_run_at ? `
                <div class="row-actions" style="gap:0.4rem;">
                  <span class="muted">最近运行：</span>
                  ${statusBadge(s.last_status)}
                  <a class="xs" href="#/runs/${s.last_run_id}">#${s.last_run_id} (${fmtRelativePast(s.last_run_at)})</a>
                </div>` : ""}
            </div>
          </div>

          <div class="row-actions between" style="padding-top:0.4rem; border-top:1px solid var(--border);">
            <a class="btn ${s.health === "error" ? "danger" : "primary"} sm" href="#/sites/${encodeURIComponent(s.site)}">${s.health === "error" ? "更新 Cookie" : "编辑配置与凭据"}</a>
            ${s.last_auth_error_run_id ? `<a class="btn ghost sm" href="#/runs/${s.last_auth_error_run_id}">错误日志</a>` : ""}
          </div>
        </article>`;
        })
        .join("")
    : `<div class="card muted">暂无站点配置。点击右上角「＋ 添加站点」开始配置 Cookie 或认证凭据。</div>`;

  hostEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1>站点与凭据健康</h1>
        <p class="muted sm" style="margin:0.2rem 0 0;">集中查看各站点 Cookie 状态、最近认证失败记录与关联的定时任务</p>
      </div>
      <div class="row-actions">
        <a class="btn primary" href="#/sites/new">＋ 添加站点</a>
      </div>
    </div>
    <div class="sites-grid">${cardsHtml}</div>
  `;
}

export async function mount(el) {
  unmounted = false;
  hostEl = el;
  el.innerHTML = `<div class="notice muted">正在加载站点健康状态…</div>`;
  await renderSites();
}

export function onEvent(ev) {
  if (["config_changed", "run_finished", "tasks_changed", "poll_tick"].includes(ev.type)) {
    renderSites().catch(() => {});
  }
}

export function unmount() {
  unmounted = true;
  hostEl = null;
}
