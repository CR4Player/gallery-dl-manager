import { api } from "../api.js";
import { el, toast, detectSiteFromUrl, SITE_LABELS, healthBadge } from "../util.js";
import { navigate } from "../router.js";
import { createDownloadOptions } from "./download-options.js";

let initialized = false;
let optionsCtrl = null;
let siteHealthMap = {};
let uploadedInputFilename = "";

function updateDetectedSites(urlsText, statusBox) {
  const lines = urlsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const sites = [...new Set(lines.map(detectSiteFromUrl).filter(Boolean))];
  statusBox.innerHTML = "";
  if (!sites.length) {
    statusBox.classList.add("hidden");
    return;
  }
  statusBox.classList.remove("hidden");

  for (const site of sites) {
    const h = siteHealthMap[site];
    const health = h?.health || "unknown";
    const row = el(
      "div",
      { class: "fl-infobar sm", style: { justifyContent: "space-between" } },
      el(
        "div",
        { class: "row-actions sm-gap" },
        el("span", { class: `health-dot ${health}` }),
        el("strong", { class: "sm" }, SITE_LABELS[site] || site),
        healthBadge(health, h?.message || undefined)
      ),
      health === "error" || health === "warn" || health === "unknown"
        ? el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle xs",
              onClick: () => {
                document.getElementById("download-drawer")?.close?.();
                navigate(`#site/${encodeURIComponent(site)}`);
              },
            },
            "配置站点凭据 →"
          )
        : null
    );
    statusBox.appendChild(row);
  }
}

async function populateDrawerData(prefill = {}) {
  const urlsEl = document.getElementById("nd-urls");
  const nameEl = document.getElementById("nd-name");
  const simEl = document.getElementById("nd-simulate");
  const inputSel = document.getElementById("nd-input-file");
  const fileEl = document.getElementById("nd-file");
  const fileClearBtn = document.getElementById("nd-file-clear");
  const fileStatus = document.getElementById("nd-file-status");
  const statusBox = document.getElementById("nd-site-status");
  const optionsSlot = document.getElementById("nd-options-slot");

  uploadedInputFilename = "";
  if (fileEl) fileEl.value = "";
  fileClearBtn?.classList.add("hidden");
  if (fileStatus) {
    fileStatus.classList.add("hidden");
    fileStatus.textContent = "";
  }

  if (urlsEl && prefill.urls !== undefined) {
    urlsEl.value = Array.isArray(prefill.urls) ? prefill.urls.join("\n") : String(prefill.urls || "");
  } else if (urlsEl && !urlsEl.value) {
    urlsEl.value = "";
  }
  if (nameEl && prefill.name !== undefined) nameEl.value = prefill.name || "";
  if (simEl) simEl.checked = Boolean(prefill.simulate);

  const [overviewRes, inputsRes, sitesHealthRes] = await Promise.all([
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/inputs").catch(() => null),
    api.get("/api/sites/health").catch(() => null),
  ]);

  siteHealthMap = {};
  const healthList = sitesHealthRes?.sites || sitesHealthRes?.items || [];
  if (Array.isArray(healthList)) {
    for (const s of healthList) {
      if (s.site) siteHealthMap[s.site] = s;
    }
  } else if (sitesHealthRes && typeof sitesHealthRes === "object") {
    siteHealthMap = sitesHealthRes;
  }

  if (inputSel) {
    const prev = inputSel.value;
    const files = inputsRes?.files || inputsRes?.items || (Array.isArray(inputsRes) ? inputsRes : []);
    inputSel.innerHTML = "";
    inputSel.appendChild(el("option", { value: "" }, "不使用 NAS 列表"));
    for (const f of files) {
      const name = typeof f === "string" ? f : f.filename || f.name;
      if (name) inputSel.appendChild(el("option", { value: name }, name));
    }
    if (prev) inputSel.value = prev;
  }

  if (optionsSlot) {
    optionsSlot.innerHTML = "";
    optionsCtrl = createDownloadOptions({
      initial: prefill.options || {},
      overview: overviewRes,
      getContextUrl: () => urlsEl?.value || "",
    });
    optionsSlot.appendChild(optionsCtrl.el);
  }

  if (urlsEl && statusBox) {
    updateDetectedSites(urlsEl.value, statusBox);
  }
}

function ensureBound() {
  if (initialized) return;
  initialized = true;

  const dialog = document.getElementById("download-drawer");
  const form = document.getElementById("new-download-form");
  const urlsEl = document.getElementById("nd-urls");
  const statusBox = document.getElementById("nd-site-status");
  const fileEl = document.getElementById("nd-file");
  const fileClearBtn = document.getElementById("nd-file-clear");
  const fileStatus = document.getElementById("nd-file-status");
  const inputSel = document.getElementById("nd-input-file");
  const submitBtn = document.getElementById("nd-submit-btn");

  const closeDrawer = () => dialog?.close?.();
  document.getElementById("download-drawer-close")?.addEventListener("click", closeDrawer);
  document.getElementById("nd-cancel-btn")?.addEventListener("click", closeDrawer);

  urlsEl?.addEventListener("input", () => {
    if (statusBox) updateDetectedSites(urlsEl.value, statusBox);
    optionsCtrl?.refreshPreview();
  });

  fileEl?.addEventListener("change", async () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      const upRes = await api.post("/api/inputs/upload", {
        filename: file.name,
        content,
      }).catch(() => null);

      if (upRes?.filename && inputSel) {
        uploadedInputFilename = upRes.filename;
        if (![...inputSel.options].some((o) => o.value === uploadedInputFilename)) {
          inputSel.appendChild(el("option", { value: uploadedInputFilename }, uploadedInputFilename));
        }
        inputSel.value = uploadedInputFilename;
      } else if (urlsEl && lines.length) {
        urlsEl.value = [urlsEl.value.trim(), ...lines].filter(Boolean).join("\n");
        if (statusBox) updateDetectedSites(urlsEl.value, statusBox);
      }

      if (fileStatus) {
        fileStatus.textContent = `已加载 ${file.name}（共 ${lines.length} 条有效链接）`;
        fileStatus.classList.remove("hidden");
      }
      fileClearBtn?.classList.remove("hidden");
      toast(`已解析 ${lines.length} 条链接`);
    } catch (err) {
      toast(`读取文件失败：${err.message}`, "danger");
    }
  });

  fileClearBtn?.addEventListener("click", () => {
    if (fileEl) fileEl.value = "";
    if (uploadedInputFilename && inputSel && inputSel.value === uploadedInputFilename) {
      inputSel.value = "";
    }
    uploadedInputFilename = "";
    fileClearBtn.classList.add("hidden");
    if (fileStatus) {
      fileStatus.classList.add("hidden");
      fileStatus.textContent = "";
    }
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const urls = (urlsEl?.value || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const inputFile = inputSel?.value || "";

    if (!urls.length && !inputFile) {
      toast("请至少输入一个目标 URL 或选择链接列表文件", "danger");
      urlsEl?.focus();
      return;
    }

    const name = document.getElementById("nd-name")?.value.trim() || "";
    const simulate = Boolean(document.getElementById("nd-simulate")?.checked);
    const optPayload = optionsCtrl?.getPayload() || {};

    submitBtn.disabled = true;
    submitBtn.textContent = "正在入队…";
    try {
      const res = await api.post("/api/download", {
        urls,
        input_file: inputFile || undefined,
        name: name || undefined,
        simulate,
        ...optPayload,
      });
      dialog?.close?.();
      toast(res?.run_id ? `已加入下载队列 (Run #${res.run_id})` : "已加入下载队列");
      if (res?.run_id) {
        navigate(`#runs/${res.run_id}`);
      } else {
        navigate("#runs");
      }
    } catch (err) {
      toast(`提交下载失败：${err.message}`, "danger");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "加入下载队列";
    }
  });
}

export async function openDownloadDrawer(prefill = {}) {
  ensureBound();
  const dialog = document.getElementById("download-drawer");
  if (!dialog) return;
  if (typeof dialog.showModal === "function" && !dialog.open) {
    dialog.showModal();
  }
  await populateDrawerData(prefill);
}
