import { api, getSitesHealth } from "../api.js";
import { navigate } from "../router.js";
import {
  debounce,
  esc,
  healthBadge,
  initDialogBackdropFallback,
  matchSitesLocally,
  showToast,
  upgradeSwitches,
} from "../util.js";
import { mountDownloadOptions } from "./download-options.js";

let fileText = "";
let optionsApi = null;
let cachedSites = [];

export async function openNewDownloadDrawer(prefill = {}) {
  const drawer = document.getElementById("download-drawer");
  if (!drawer) return;

  const urlsEl = document.getElementById("nd-urls");
  const nameEl = document.getElementById("nd-name");
  const inputSel = document.getElementById("nd-input-file");
  const simEl = document.getElementById("nd-simulate");
  const fileEl = document.getElementById("nd-file");
  const fileStatus = document.getElementById("nd-file-status");
  const fileClear = document.getElementById("nd-file-clear");

  fileText = "";
  fileEl.value = "";
  fileStatus.classList.add("hidden");
  fileClear.classList.add("hidden");

  urlsEl.value = prefill.urls || "";
  nameEl.value = prefill.name || "";
  simEl.checked = Boolean(prefill.simulate);

  try {
    const [inputsRes, sites] = await Promise.all([api("/api/inputs"), getSitesHealth()]);
    cachedSites = sites;
    const files = inputsRes.files || [];
    inputSel.innerHTML =
      `<option value="">不使用 NAS 列表</option>` +
      files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)} (${f.url_count} 条 URL)</option>`).join("");
    if (prefill.input_file) inputSel.value = prefill.input_file;
  } catch {}

  if (!optionsApi) {
    optionsApi = mountDownloadOptions(document.getElementById("nd-options-slot"), {
      initial: prefill.options || {},
      getContext: () => ({
        urls: urlsEl.value,
        file_content: fileText,
        input_file: inputSel.value,
        simulate: simEl.checked,
      }),
    });
  } else {
    optionsApi.setValues(prefill.options || {});
  }

  await updateSiteDetection();
  drawer.showModal();
  urlsEl.focus();
}

async function updateSiteDetection() {
  const statusBox = document.getElementById("nd-site-status");
  const urlsEl = document.getElementById("nd-urls");
  const combined = [urlsEl.value, fileText].filter(Boolean).join("\n");
  if (!cachedSites.length) {
    try {
      cachedSites = await getSitesHealth();
    } catch {}
  }
  const matched = matchSitesLocally(combined, cachedSites);
  if (!matched.length) {
    statusBox.classList.add("hidden");
    statusBox.innerHTML = "";
    return;
  }

  const bySite = new Map(cachedSites.map((s) => [s.site, s]));
  const chips = matched
    .map((site) => {
      const info = bySite.get(site);
      const badge = info ? healthBadge(info.health) : `<span class="badge">未配置凭据</span>`;
      return `<span class="badge">${esc(site)} ${badge}</span>`;
    })
    .join(" ");

  const alertsHtml = matched
    .map((site) => {
      const info = bySite.get(site);
      if (info && info.health === "error") {
        return `
          <div class="notice danger banner-row">
            <span class="sm">⚠ <strong>${esc(site)}</strong> 最近一次抓取发生认证失效：${esc(info.last_auth_error_summary || "Cookie 已过期")}</span>
            <button type="button" class="btn danger sm" data-nd-goto-site="${esc(site)}">去更新 Cookie</button>
          </div>`;
      }
      if (!info || (!info.has_credentials && ["twitter", "pixiv", "fanbox", "patreon", "instagram"].includes(site))) {
        return `
          <div class="notice warn banner-row">
            <span class="sm">提示：<strong>${esc(site)}</strong> 尚未配置 Cookie 或登录凭据。</span>
            <button type="button" class="btn ghost sm" data-nd-goto-site="${esc(site)}">配置站点</button>
          </div>`;
      }
      return "";
    })
    .filter(Boolean)
    .join("");

  statusBox.innerHTML = `<div class="row-actions">${chips}</div>${alertsHtml}`;
  statusBox.classList.remove("hidden");
}

export function initNewDownloadDrawer() {
  const drawer = document.getElementById("download-drawer");
  if (!drawer) return;
  initDialogBackdropFallback(drawer);
  upgradeSwitches(drawer);

  const form = document.getElementById("new-download-form");
  const urlsEl = document.getElementById("nd-urls");
  const fileEl = document.getElementById("nd-file");
  const fileStatus = document.getElementById("nd-file-status");
  const fileClear = document.getElementById("nd-file-clear");
  const inputSel = document.getElementById("nd-input-file");
  const advDetails = document.getElementById("nd-advanced-details");

  document.getElementById("open-download-btn")?.addEventListener("click", () => openNewDownloadDrawer());
  document.getElementById("download-drawer-close")?.addEventListener("click", () => drawer.close());
  document.getElementById("nd-cancel-btn")?.addEventListener("click", () => drawer.close());

  const debouncedDetect = debounce(() => {
    updateSiteDetection();
    optionsApi?.refreshEffective();
  }, 200);

  urlsEl.addEventListener("input", debouncedDetect);
  inputSel.addEventListener("change", () => optionsApi?.refreshEffective());
  document.getElementById("nd-simulate")?.addEventListener("change", () => optionsApi?.refreshEffective());

  advDetails.addEventListener("toggle", () => {
    if (advDetails.open) optionsApi?.refreshEffective();
  });

  fileEl.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) {
      fileText = "";
      fileStatus.classList.add("hidden");
      fileClear.classList.add("hidden");
      return;
    }
    fileText = await file.text();
    const cnt = fileText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    fileStatus.textContent = `已读取 ${file.name}（${cnt} 条有效链接，提交将自动走 -i）`;
    fileStatus.classList.remove("hidden");
    fileClear.classList.remove("hidden");
    debouncedDetect();
  });

  fileClear.addEventListener("click", () => {
    fileText = "";
    fileEl.value = "";
    fileStatus.classList.add("hidden");
    fileClear.classList.add("hidden");
    debouncedDetect();
  });

  drawer.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nd-goto-site]");
    if (!btn) return;
    const site = btn.dataset.ndGotoSite;
    drawer.close();
    navigate(`#/sites/${encodeURIComponent(site)}`);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const urls = urlsEl.value.trim();
    const inpFile = inputSel.value;
    if (!urls && !fileText.trim() && !inpFile) {
      showToast("请输入目标 URL 或选择链接列表文件", "danger");
      urlsEl.focus();
      return;
    }
    const opts = optionsApi ? optionsApi.getValues() : {};
    const btn = document.getElementById("nd-submit-btn");
    btn.disabled = true;
    try {
      const res = await api("/api/download", {
        method: "POST",
        body: {
          ...opts,
          urls,
          file_content: fileText,
          input_file: inpFile,
          simulate: document.getElementById("nd-simulate").checked,
          name: document.getElementById("nd-name").value.trim() || "临时下载",
        },
      });
      drawer.close();
      showToast(`已入队 Run #${res.run_id}`);
      navigate(`#/runs/${res.run_id}`);
    } catch (err) {
      showToast(err.message, "danger");
    } finally {
      btn.disabled = false;
    }
  });
}
