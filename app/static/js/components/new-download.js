import { api } from "../api.js";
import { el, toast, detectSiteFromUrl, SITE_LABELS, healthBadge } from "../util.js";
import { icon } from "../icons.js";
import { navigate } from "../router.js";
import { createDownloadOptions } from "./download-options.js";

let initialized = false;
let optionsCtrl = null;
let siteHealthMap = {};
let listSource = "local";
let localFileLines = [];
let localFileName = "";
let mergeHintEl = null;

function parseLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function getCombinedUrls(urlsEl) {
  const extra = listSource === "local" ? localFileLines : [];
  return [...parseLines(urlsEl?.value || ""), ...extra];
}

function getActiveInputFile(inputSel) {
  return listSource === "nas" ? inputSel?.value || "" : "";
}

function updateMergeHint(urlsEl, inputSel) {
  if (!mergeHintEl) return;
  const hasTypedUrls = parseLines(urlsEl?.value || "").length > 0;
  const hasLocal = listSource === "local" && localFileLines.length > 0;
  const hasNas = listSource === "nas" && Boolean(inputSel?.value);
  const bodyEl = mergeHintEl.querySelector(".infobar-body");
  if (hasTypedUrls && hasNas) {
    if (bodyEl) bodyEl.textContent = "已同时填写目标 URL 与 NAS 列表，运行时将合并执行。";
    mergeHintEl.classList.remove("hidden");
  } else if (hasTypedUrls && hasLocal) {
    if (bodyEl) bodyEl.textContent = "已同时填写目标 URL 与本地 .txt，提交时将合并入队。";
    mergeHintEl.classList.remove("hidden");
  } else {
    mergeHintEl.classList.add("hidden");
  }
}

function setListSource(nextSource, { clearOther = true } = {}) {
  listSource = nextSource === "nas" ? "nas" : "local";

  const seg = document.getElementById("nd-list-source-seg");
  const paneLocal = document.getElementById("nd-pane-local");
  const paneNas = document.getElementById("nd-pane-nas");
  const fileEl = document.getElementById("nd-file");
  const fileClearBtn = document.getElementById("nd-file-clear");
  const fileStatus = document.getElementById("nd-file-status");
  const inputSel = document.getElementById("nd-input-file");
  const urlsEl = document.getElementById("nd-urls");
  const statusBox = document.getElementById("nd-site-status");

  seg?.querySelectorAll(".fl-seg-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.source === listSource ? "true" : "false");
  });
  paneLocal?.classList.toggle("hidden", listSource !== "local");
  paneNas?.classList.toggle("hidden", listSource !== "nas");

  if (clearOther) {
    if (listSource === "nas") {
      localFileLines = [];
      localFileName = "";
      if (fileEl) fileEl.value = "";
      fileClearBtn?.classList.add("hidden");
      if (fileStatus) {
        fileStatus.classList.add("hidden");
        fileStatus.textContent = "";
      }
    } else if (inputSel) {
      inputSel.value = "";
    }
  }

  if (urlsEl && statusBox) {
    updateDetectedSites(getCombinedUrls(urlsEl), statusBox);
  }
  updateMergeHint(urlsEl, inputSel);
  optionsCtrl?.refreshPreview();
}

function updateDetectedSites(urlsText, statusBox) {
  const lines = Array.isArray(urlsText) ? urlsText : parseLines(urlsText);
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
    const infoText =
      h?.last_auth_error_summary ||
      (h?.has_credentials ? `已配凭据 (${h.cookie_count || 0} Cookie)` : "尚未配置凭据");
    const row = el(
      "div",
      { class: "fl-infobar sm" },
      el("span", { class: "infobar-icon" }, el("span", { class: `health-dot ${health}` })),
      el(
        "div",
        { class: "infobar-body" },
        el(
          "div",
          { class: "row-actions sm-gap" },
          el("strong", { class: "sm" }, SITE_LABELS[site] || site),
          healthBadge(health)
        ),
        el("span", { class: "muted xs" }, infoText)
      ),
      health === "error" || health === "warn" || health === "unknown" || !h?.has_credentials
        ? el(
            "div",
            { class: "infobar-actions" },
            el(
              "button",
              {
                type: "button",
                class: "fl-btn subtle xs",
                onClick: () => {
                  document.getElementById("download-drawer")?.close?.();
                  navigate(`#site/${encodeURIComponent(site)}`);
                },
              },
              "配置凭据",
              icon("chevron-right", 13)
            )
          )
        : null
    );
    statusBox.appendChild(row);
  }
}

function resetDrawerForm() {
  const urlsEl = document.getElementById("nd-urls");
  const nameEl = document.getElementById("nd-name");
  const simEl = document.getElementById("nd-simulate");
  const inputSel = document.getElementById("nd-input-file");
  const fileEl = document.getElementById("nd-file");
  const fileClearBtn = document.getElementById("nd-file-clear");
  const fileStatus = document.getElementById("nd-file-status");
  const statusBox = document.getElementById("nd-site-status");
  const advDetails = document.getElementById("nd-advanced-details");

  localFileLines = [];
  localFileName = "";
  if (urlsEl) urlsEl.value = "";
  if (nameEl) nameEl.value = "";
  if (simEl) simEl.checked = false;
  if (inputSel) inputSel.value = "";
  if (fileEl) fileEl.value = "";
  fileClearBtn?.classList.add("hidden");
  if (fileStatus) {
    fileStatus.classList.add("hidden");
    fileStatus.textContent = "";
  }
  if (statusBox) {
    statusBox.classList.add("hidden");
    statusBox.innerHTML = "";
  }
  if (advDetails) advDetails.open = false;
  setListSource("local", { clearOther: true });
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
  const advDetails = document.getElementById("nd-advanced-details");

  localFileLines = [];
  localFileName = "";
  if (fileEl) fileEl.value = "";
  fileClearBtn?.classList.add("hidden");
  if (fileStatus) {
    fileStatus.classList.add("hidden");
    fileStatus.textContent = "";
  }

  if (urlsEl) {
    urlsEl.value = prefill.urls !== undefined
      ? (Array.isArray(prefill.urls) ? prefill.urls.join("\n") : String(prefill.urls || ""))
      : "";
  }
  if (nameEl) nameEl.value = prefill.name !== undefined ? prefill.name || "" : "";
  if (simEl) simEl.checked = Boolean(prefill.simulate);
  if (advDetails) advDetails.open = Boolean(prefill.options);

  const [overviewRes, inputsRes, sitesHealthRes] = await Promise.all([
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/inputs").catch(() => null),
    api.get("/api/sites/health").catch(() => null),
  ]);

  siteHealthMap = {};
  const healthList = Array.isArray(sitesHealthRes?.sites) ? sitesHealthRes.sites : [];
  for (const s of healthList) {
    if (s && s.site) siteHealthMap[s.site] = s;
  }

  if (inputSel) {
    const files = Array.isArray(inputsRes?.files) ? inputsRes.files : [];
    inputSel.innerHTML = "";
    inputSel.appendChild(el("option", { value: "" }, "不使用 NAS 列表"));
    for (const f of files) {
      const name = typeof f === "string" ? f : f.name || f.filename;
      if (name) inputSel.appendChild(el("option", { value: name }, `${name}${f.url_count ? ` (${f.url_count} 条)` : ""}`));
    }
    inputSel.value = prefill.input_file || "";
  }

  if (optionsSlot) {
    optionsSlot.innerHTML = "";
    optionsCtrl = createDownloadOptions({
      initial: prefill.options || {},
      overview: overviewRes,
      getContextUrls: () => getCombinedUrls(urlsEl).join("\n"),
      getInputFile: () => getActiveInputFile(inputSel),
      getSimulate: () => Boolean(simEl?.checked),
    });
    optionsSlot.appendChild(optionsCtrl.el);
  }

  setListSource(prefill.input_file ? "nas" : "local", { clearOther: false });
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
  const simEl = document.getElementById("nd-simulate");
  const submitBtn = document.getElementById("nd-submit-btn");

  if (inputSel && !mergeHintEl) {
    mergeHintEl = el(
      "div",
      { class: "fl-infobar info sm hidden" },
      el("span", { class: "infobar-icon" }, icon("info", 15)),
      el("div", { class: "infobar-body" }, "已同时填写 URL 与选择 NAS 列表，运行时将合并执行。")
    );
    statusBox?.after(mergeHintEl);
  }

  const closeDrawer = () => dialog?.close?.();
  document.getElementById("download-drawer-close")?.addEventListener("click", closeDrawer);
  document.getElementById("nd-cancel-btn")?.addEventListener("click", closeDrawer);

  document.querySelectorAll("#nd-list-source-seg .fl-seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setListSource(btn.dataset.source, { clearOther: true });
    });
  });

  urlsEl?.addEventListener("input", () => {
    if (statusBox) updateDetectedSites(getCombinedUrls(urlsEl), statusBox);
    updateMergeHint(urlsEl, inputSel);
    optionsCtrl?.refreshPreview();
  });
  inputSel?.addEventListener("change", () => {
    updateMergeHint(urlsEl, inputSel);
    optionsCtrl?.refreshPreview();
  });
  simEl?.addEventListener("change", () => optionsCtrl?.refreshPreview());

  fileEl?.addEventListener("change", async () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const lines = parseLines(content);
      if (!lines.length) {
        toast("所选文件中没有有效 URL", "danger");
        fileEl.value = "";
        return;
      }
      localFileLines = lines;
      localFileName = file.name;
      if (statusBox) updateDetectedSites(getCombinedUrls(urlsEl), statusBox);
      updateMergeHint(urlsEl, inputSel);
      optionsCtrl?.refreshPreview();

      if (fileStatus) {
        fileStatus.textContent = `已加载本地文件 ${file.name}（${lines.length} 条有效链接，提交时一并入队，不会写入 /data/inputs/）`;
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
    localFileLines = [];
    localFileName = "";
    if (statusBox) updateDetectedSites(getCombinedUrls(urlsEl), statusBox);
    updateMergeHint(urlsEl, inputSel);
    optionsCtrl?.refreshPreview();
    fileClearBtn.classList.add("hidden");
    if (fileStatus) {
      fileStatus.classList.add("hidden");
      fileStatus.textContent = "";
    }
  });

  const defaultSubmitChildren = submitBtn ? [...submitBtn.childNodes] : [];

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const urls = getCombinedUrls(urlsEl);
    const inputFile = getActiveInputFile(inputSel);

    if (!urls.length && !inputFile) {
      toast("请填写目标 URL，或选择本地 .txt / NAS 列表", "danger");
      urlsEl?.focus();
      return;
    }

    const name = document.getElementById("nd-name")?.value.trim() || (localFileName ? `临时下载 (${localFileName})` : "临时下载");
    const simulate = Boolean(simEl?.checked);
    const optPayload = optionsCtrl?.getPayload() || {};

    submitBtn.disabled = true;
    submitBtn.textContent = "正在入队…";
    try {
      const res = await api.post("/api/download", {
        urls,
        input_file: inputFile,
        name,
        simulate,
        ...optPayload,
      });
      resetDrawerForm();
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
      if (defaultSubmitChildren.length) {
        submitBtn.replaceChildren(...defaultSubmitChildren);
      } else {
        submitBtn.textContent = "加入下载队列";
      }
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
