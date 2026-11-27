/** Shared UI helpers, formatting, dialogs, popovers, switches, and local site matching. */

export const HAS_NATIVE_SWITCH = "switch" in HTMLInputElement.prototype;

const BUILTIN_DOMAINS = {
  twitter: ["twitter.com", "x.com"],
  bluesky: ["bsky.app"],
  pixiv: ["pixiv.net"],
  fanbox: ["fanbox.cc"],
  patreon: ["patreon.com"],
  rule34: ["rule34.xxx"],
  instagram: ["instagram.com"],
  deviantart: ["deviantart.com"],
  danbooru: ["danbooru.donmai.us"],
  kemonoparty: ["kemono.su", "kemono.party"],
  reddit: ["reddit.com"],
  tumblr: ["tumblr.com"],
  weibo: ["weibo.com", "weibo.cn"],
};

export function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function fmtRelativeFuture(iso) {
  if (!iso) return "";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMin = Math.round((target - Date.now()) / 60000);
  if (diffMin <= 0) return "即将执行";
  if (diffMin < 60) return `${diffMin} 分钟后`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h < 24) return m > 0 ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d} 天 ${rh} 小时后` : `${d} 天后`;
}

export function fmtRelativePast(iso) {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return "刚刚";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export function fmtDuration(sec) {
  if (sec == null) return "-";
  const n = Number(sec);
  if (Number.isNaN(n)) return "-";
  if (n < 60) return `${n.toFixed(n >= 10 ? 0 : 1)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m}m ${s}s`;
}

export function statusBadge(status, extraClass = "") {
  const labels = {
    queued: "排队中",
    running: "运行中",
    success: "成功",
    partial: "部分失败",
    auth_error: "认证失效",
    failed: "失败",
    cancelled: "已中止",
  };
  const cls = extraClass ? `badge ${esc(status)} ${esc(extraClass)}` : `badge ${esc(status)}`;
  return `<span class="${cls}">${esc(labels[status] || status)}</span>`;
}

export function healthBadge(health) {
  const map = {
    ok: { label: "正常", cls: "success" },
    warn: { label: "存在异常", cls: "partial" },
    error: { label: "认证失效", cls: "auth_error" },
    unknown: { label: "暂无记录", cls: "" },
  };
  const info = map[health] || map.unknown;
  return `<span class="badge ${info.cls}"><span class="health-dot ${esc(health || "unknown")}" aria-hidden="true"></span>${esc(info.label)}</span>`;
}

export function showToast(msg, variant = "info") {
  const region = document.getElementById("toast-region");
  if (!region) return;
  const el = document.createElement("div");
  el.className = `toast-item ${variant === "danger" ? "danger" : ""}`;
  el.textContent = msg;
  region.append(el);
  setTimeout(() => el.remove(), 3400);
}

export function confirmDialog(title, message, { confirmText = "确定", danger = false } = {}) {
  const dlg = document.getElementById("confirm-dialog");
  if (!dlg) return Promise.resolve(window.confirm(message));
  document.getElementById("confirm-dialog-title").textContent = title || "确认操作";
  document.getElementById("confirm-dialog-message").textContent = message || "";
  const okBtn = document.getElementById("confirm-dialog-ok");
  okBtn.textContent = confirmText;
  okBtn.className = danger ? "btn danger" : "btn primary";

  return new Promise((resolve) => {
    const onClose = () => {
      const val = dlg.returnValue;
      dlg.returnValue = "";
      dlg.removeEventListener("close", onClose);
      resolve(val === "confirm");
    };
    dlg.addEventListener("close", onClose);
    dlg.showModal();
  });
}

export function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function upgradeSwitches(root = document) {
  if (HAS_NATIVE_SWITCH) return;
  root.querySelectorAll('input[type="checkbox"][switch]').forEach((el) => {
    el.classList.add("switch-fallback");
  });
}

export function initDialogBackdropFallback(dialog) {
  if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;
  if (dialog.getAttribute("closedby") !== "any") return;
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => {
    pressedOutside = outside(e);
  });
  dialog.addEventListener("pointerup", (e) => {
    if (pressedOutside && outside(e)) dialog.close();
    pressedOutside = false;
  });
}

export function positionPopoverFallback(pop, trigger) {
  if (!pop || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const nearTrigger =
    Math.abs(popRect.right - rect.right) <= 48 &&
    ((popRect.top >= rect.bottom - 4 && popRect.top <= rect.bottom + 24) ||
      (popRect.bottom <= rect.top + 4 && popRect.bottom >= rect.top - 24));
  if (!nearTrigger) {
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= popRect.height + 8
        ? rect.bottom + 4
        : Math.max(8, rect.top - popRect.height - 4);
    const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, rect.right - popRect.width));
    pop.style.positionArea = "none";
    pop.style.positionAnchor = "none";
    pop.style.position = "fixed";
    pop.style.inset = "auto";
    pop.style.margin = "0";
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }
}

export function clearPopoverFallbackStyles(pop) {
  pop.style.positionArea = "";
  pop.style.positionAnchor = "";
  pop.style.position = "";
  pop.style.inset = "";
  pop.style.margin = "";
  pop.style.top = "";
  pop.style.left = "";
}

export function matchSitesLocally(urlsText, sitesHealth = []) {
  const lines = String(urlsText || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#") && !x.startsWith("file:"));

  const domainMap = new Map();
  for (const [k, doms] of Object.entries(BUILTIN_DOMAINS)) {
    domainMap.set(k, doms);
  }
  for (const s of sitesHealth) {
    if (!domainMap.has(s.site)) {
      domainMap.set(s.site, s.domains?.length ? s.domains : [`${s.site}.com`, s.site]);
    }
  }

  const matched = [];
  const seen = new Set();
  for (const line of lines) {
    let host = "";
    try {
      const normalized = line.includes("://") ? line : line.includes(".") ? `https://${line}` : "";
      if (!normalized) continue;
      host = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (!host) continue;
    for (const [site, doms] of domainMap.entries()) {
      if (seen.has(site)) continue;
      const hit = doms.some((dom) => {
        if (dom.includes(".")) return host === dom || host.endsWith(`.${dom}`);
        return host.split(".").includes(dom);
      });
      if (hit) {
        seen.add(site);
        matched.push(site);
      }
    }
  }
  return matched;
}
