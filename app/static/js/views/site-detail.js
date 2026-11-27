import { api, getConfigOverview, getSitesHealth, invalidateSharedCache } from "../api.js";
import { navigate } from "../router.js";
import {
  confirmDialog,
  debounce,
  esc,
  fmtTime,
  healthBadge,
  showToast,
  upgradeSwitches,
} from "../util.js";

let hostEl = null;
let unmounted = false;
let editingSite = "";

const PRESET_SITES = ["twitter", "bluesky", "pixiv", "rule34", "fanbox", "patreon", "instagram"];

async function refreshPpPreview() {
  const enabled = document.getElementById("sd-pp")?.checked;
  const panel = document.getElementById("sd-pp-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !enabled);
  if (!enabled) return;

  const ptype = document.getElementById("sd-pp-type").value;
  document.getElementById("sd-pp-date-wrap").classList.toggle("hidden", ptype !== "builtin");
  document.getElementById("sd-pp-extra-wrap").classList.toggle("hidden", ptype !== "builtin");
  document.getElementById("sd-pp-cmd-wrap").classList.toggle("hidden", ptype !== "custom");

  const out = document.getElementById("sd-pp-preview");
  try {
    const res = await api("/api/config/postprocess-preview", {
      method: "POST",
      body: {
        mode: ptype,
        date_template: document.getElementById("sd-pp-date").value.trim(),
        extra_args: document.getElementById("sd-pp-extra").value.trim(),
        custom_command: document.getElementById("sd-pp-cmd").value.trim(),
      },
    });
    const lines = [`exec: ${res.exec_command || ""}`];
    if (res.exiftool_image_cmd) lines.push(`图片: ${res.exiftool_image_cmd}`);
    if (res.exiftool_video_cmd) lines.push(`视频: ${res.exiftool_video_cmd}`);
    out.textContent = lines.join("\n");
  } catch (err) {
    out.textContent = err.message;
  }
}

export async function mount(el, params) {
  unmounted = false;
  hostEl = el;
  editingSite = params.name || "";
  const isNew = !editingSite;

  el.innerHTML = `<div class="notice muted">正在加载站点配置…</div>`;

  let siteData = null;
  let globalDefaultSkip = "";
  let healthInfo = null;

  const [ov, allHealth] = await Promise.all([
    getConfigOverview().catch(() => ({ default_skip: "" })),
    getSitesHealth().catch(() => []),
  ]);
  globalDefaultSkip = ov.default_skip || "abort:7";
  if (!isNew) {
    healthInfo = (allHealth || []).find((x) => x.site === editingSite) || null;
    try {
      siteData = await api(`/api/config/site/${encodeURIComponent(editingSite)}`);
    } catch {
      siteData = null;
    }
  }
  if (unmounted) return;

  const pcfg = siteData?.postprocess_config || {};
  const ppEnabled = Boolean(siteData?.postprocess_enabled);
  const ppType = pcfg.mode || "builtin";

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="breadcrumbs"><a href="#/sites">← 站点与凭据</a><span>/</span><span>${isNew ? "新增站点" : esc(editingSite)}</span></div>
        <div class="row-actions">
          <h1>${isNew ? "添加站点配置" : `站点：${esc(editingSite)}`}</h1>
          ${healthInfo ? healthBadge(healthInfo.health) : ""}
        </div>
      </div>
      ${!isNew ? `<button type="button" class="btn danger sm" id="sd-delete-btn">删除站点配置</button>` : ""}
    </div>

    ${healthInfo?.health === "error" ? `
      <div class="notice danger banner-row">
        <div>
          <strong>该站点最近发生认证失效（${fmtTime(healthInfo.last_auth_error_at)}）</strong>
          <div class="sm">${esc(healthInfo.last_auth_error_summary || "请粘贴浏览器最新导出的 Cookies")}</div>
        </div>
        ${healthInfo.last_auth_error_run_id ? `<a class="btn ghost sm" href="#/runs/${healthInfo.last_auth_error_run_id}">查看失败日志</a>` : ""}
      </div>` : ""}

    <form id="site-detail-form" class="stack" novalidate>
      <section class="card stack">
        <div class="card-head" style="margin-bottom:0;">
          <h2>1. Cookies（最常维护）</h2>
          <span class="muted sm">支持 Netscape cookies.txt、JSON 对象/数组或 Cookie 请求头</span>
        </div>

        ${isNew ? `
          <div class="field">
            <label for="sd-site">站点标识 (gallery-dl extractor key)</label>
            <input id="sd-site" type="text" required placeholder="例如 twitter / bluesky / rule34 / pixiv">
            <div class="chip-group" style="margin-top:0.25rem;">
              ${PRESET_SITES.map((s) => `<button type="button" class="chip-btn" data-preset-site="${s}">${s}</button>`).join("")}
            </div>
          </div>` : `<input id="sd-site" type="hidden" value="${esc(editingSite)}">`}

        <div class="stack xs-gap">
          <span class="sm muted">当前已保存的 Cookie 键名（${siteData?.cookie_keys?.length || 0} 项）：</span>
          <div class="cookie-chips">
            ${siteData?.cookie_keys?.length
              ? siteData.cookie_keys.map((k) => `<span class="ov-source-tag">${esc(k)}</span>`).join("")
              : `<span class="muted xs">暂无 Cookie</span>`}
          </div>
        </div>

        <div class="field">
          <label for="sd-cookies">粘贴新的 Cookies（留空则保留现有 Cookies）</label>
          <textarea id="sd-cookies" rows="5" class="mono-area" placeholder="粘贴 Netscape cookies.txt、JSON 或 Cookie 请求头文本…"></textarea>
        </div>
        <label class="checkbox-inline">
          <input type="checkbox" class="checkbox-custom" id="sd-clear-cookies"> 清空已有 Cookies
        </label>
      </section>

      <section class="card stack">
        <h2 style="margin:0; font-size:1.05rem;">2. 登录凭据与请求头</h2>
        <div class="form-grid-2">
          <div class="field">
            <label for="sd-username">用户名 (可选)</label>
            <input id="sd-username" type="text" value="${esc(siteData?.username || "")}">
          </div>
          <div class="field">
            <label for="sd-password">密码 ${siteData?.has_password ? "（已设置，留空保持不变）" : "（可选）"}</label>
            <input id="sd-password" type="password" autocomplete="new-password">
            ${siteData?.has_password ? `<label class="checkbox-inline xs"><input type="checkbox" class="checkbox-custom" id="sd-clear-pw"> 清空已有密码</label>` : ""}
          </div>
          <div class="field">
            <label for="sd-userid">User ID (如 Rule34)</label>
            <input id="sd-userid" type="text" value="${esc(siteData?.user_id || "")}">
          </div>
          <div class="field">
            <label for="sd-apikey">API Key ${siteData?.has_api_key ? "（已设置，留空保持不变）" : "（可选）"}</label>
            <input id="sd-apikey" type="password">
            ${siteData?.has_api_key ? `<label class="checkbox-inline xs"><input type="checkbox" class="checkbox-custom" id="sd-clear-apikey"> 清空已有 API Key</label>` : ""}
          </div>
          <div class="field">
            <label for="sd-browser">Browser 模拟 (如 chrome / firefox)</label>
            <input id="sd-browser" type="text" value="${esc(siteData?.browser || "")}" placeholder="chrome">
          </div>
          <div class="field">
            <label for="sd-ua">User-Agent (可选)</label>
            <input id="sd-ua" type="text" value="${esc(siteData?.user_agent || "")}" placeholder="留空默认，或 +chrome">
          </div>
        </div>
      </section>

      <section class="card stack">
        <h2 style="margin:0; font-size:1.05rem;">3. 站点默认下载与 ExifTool 后处理</h2>
        <div class="form-grid-2">
          <div class="field">
            <label for="sd-skip">站点 Skip 阈值（覆盖全局 ${esc(globalDefaultSkip)}）</label>
            <input id="sd-skip" type="text" value="${esc(siteData?.skip || "")}" placeholder="留空沿用全局 ${esc(globalDefaultSkip)}">
          </div>
          <div class="field">
            <label for="sd-filename">文件命名模板（可选）</label>
            <input id="sd-filename" type="text" value="${esc(siteData?.filename || "")}" placeholder="[{date:%Y-%m-%d}] {id}.{extension}">
          </div>
        </div>

        <label class="checkbox-inline">
          <input type="checkbox" switch role="switch" class="switch-ok" id="sd-pp" ${ppEnabled ? "checked" : ""}> 为此站点默认启用 ExifTool 后处理
        </label>

        <div id="sd-pp-panel" class="sub-panel stack sm-gap ${ppEnabled ? "" : "hidden"}">
          <div class="form-grid-2">
            <div class="field">
              <label for="sd-pp-type">后处理方式</label>
              <select id="sd-pp-type">
                <option value="builtin" ${ppType === "builtin" ? "selected" : ""}>内置智能 ExifTool + mtime</option>
                <option value="custom" ${ppType === "custom" ? "selected" : ""}>自定义 exec 指令</option>
              </select>
            </div>
            <div id="sd-pp-date-wrap" class="field">
              <label for="sd-pp-date">日期字段模板</label>
              <input id="sd-pp-date" type="text" value="${esc(pcfg.date_template || "{date:%Y-%m-%dT%H:%M:%S}")}">
            </div>
          </div>
          <div id="sd-pp-extra-wrap" class="field">
            <label for="sd-pp-extra">额外 ExifTool 参数（可选）</label>
            <input id="sd-pp-extra" type="text" value="${esc(pcfg.extra_args || "")}" placeholder="例如 -Artist={author[name]}">
          </div>
          <div id="sd-pp-cmd-wrap" class="field hidden">
            <label for="sd-pp-cmd">自定义 exec 指令</label>
            <textarea id="sd-pp-cmd" rows="2" class="mono-area">${esc(pcfg.custom_command || "")}</textarea>
          </div>
          <div class="field">
            <span class="hint">实际执行指令预览：</span>
            <pre id="sd-pp-preview" class="cmd-preview"></pre>
          </div>
        </div>
      </section>

      ${healthInfo?.task_ids?.length ? `
        <section class="card stack sm-gap">
          <h2 style="margin:0; font-size:1.05rem;">引用此站点的定时任务</h2>
          <div class="row-actions">
            ${healthInfo.task_ids.map((tid, i) => `<a class="btn ghost sm" href="#/tasks/${tid}">${esc(healthInfo.task_names?.[i] || `#${tid}`)}</a>`).join("")}
          </div>
        </section>` : ""}

      <div class="row-actions between">
        <a class="btn ghost" href="#/sites">返回站点列表</a>
        <button type="submit" class="btn primary">保存站点配置</button>
      </div>
    </form>
  `;

  upgradeSwitches(el);
  refreshPpPreview();

  const debouncedPp = debounce(refreshPpPreview, 200);
  document.getElementById("sd-pp").addEventListener("change", refreshPpPreview);
  document.getElementById("sd-pp-type").addEventListener("change", refreshPpPreview);
  document.getElementById("sd-pp-date").addEventListener("input", debouncedPp);
  document.getElementById("sd-pp-extra").addEventListener("input", debouncedPp);
  document.getElementById("sd-pp-cmd").addEventListener("input", debouncedPp);

  el.addEventListener("click", onClick);
  document.getElementById("site-detail-form").addEventListener("submit", onSubmit);
}

async function onClick(e) {
  const preset = e.target.closest("[data-preset-site]");
  if (preset) {
    const inp = document.getElementById("sd-site");
    if (inp) inp.value = preset.dataset.presetSite;
    return;
  }
  if (e.target.id === "sd-delete-btn" && editingSite) {
    const ok = await confirmDialog("删除站点配置", `确定删除站点 ${editingSite} 的配置与凭据？`, {
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/config/site/${encodeURIComponent(editingSite)}`, { method: "DELETE" });
      invalidateSharedCache();
      showToast(`已删除站点 ${editingSite}`);
      navigate("#/sites");
    } catch (err) {
      showToast(err.message, "danger");
    }
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const site = (document.getElementById("sd-site")?.value || "").trim().toLowerCase();
  if (!site) {
    showToast("请填写站点标识", "danger");
    return;
  }
  try {
    const res = await api(`/api/config/site/${encodeURIComponent(site)}`, {
      method: "PUT",
      body: {
        username: document.getElementById("sd-username").value.trim(),
        password: document.getElementById("sd-password").value,
        clear_password: Boolean(document.getElementById("sd-clear-pw")?.checked),
        user_id: document.getElementById("sd-userid").value.trim(),
        api_key: document.getElementById("sd-apikey").value,
        clear_api_key: Boolean(document.getElementById("sd-clear-apikey")?.checked),
        browser: document.getElementById("sd-browser").value.trim(),
        user_agent: document.getElementById("sd-ua").value.trim(),
        filename: document.getElementById("sd-filename").value.trim(),
        skip: document.getElementById("sd-skip").value.trim(),
        cookies_input: document.getElementById("sd-cookies").value,
        clear_cookies: document.getElementById("sd-clear-cookies").checked,
        postprocess_enabled: document.getElementById("sd-pp").checked,
        postprocess_type: document.getElementById("sd-pp-type").value,
        postprocess_date_field: document.getElementById("sd-pp-date").value.trim(),
        postprocess_extra_args: document.getElementById("sd-pp-extra").value.trim(),
        postprocess_command: document.getElementById("sd-pp-cmd").value.trim(),
      },
    });
    invalidateSharedCache();
    showToast(`站点 ${site} 已保存 (Cookies: ${res.cookie_count})`);
    if (!editingSite) {
      navigate(`#/sites/${encodeURIComponent(site)}`);
    } else {
      const targetEl = hostEl;
      unmount();
      await mount(targetEl, { name: site });
    }
  } catch (err) {
    showToast(err.message, "danger");
  }
}

export function unmount() {
  unmounted = true;
  if (hostEl) hostEl.removeEventListener("click", onClick);
  hostEl = null;
}
