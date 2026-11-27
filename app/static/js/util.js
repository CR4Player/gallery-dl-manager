export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class" || k === "className") {
        node.className = v;
      } else if (k === "style" && typeof v === "object") {
        Object.assign(node.style, v);
      } else if (k === "dataset" && typeof v === "object") {
        Object.assign(node.dataset, v);
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) {
        node.setAttribute(k, "");
      } else if (k in node && k !== "list" && k !== "form" && !k.startsWith("aria-") && !k.startsWith("data-")) {
        try {
          node[k] = v;
        } catch {
          node.setAttribute(k, String(v));
        }
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  const append = (item) => {
    if (item === undefined || item === null || item === false) return;
    if (Array.isArray(item)) {
      item.forEach(append);
    } else if (item instanceof Node) {
      node.appendChild(item);
    } else {
      node.appendChild(document.createTextNode(String(item)));
    }
  };
  children.forEach(append);
  return node;
}

export function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtTimeShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(sec) {
  if (sec === undefined || sec === null || Number.isNaN(Number(sec))) return "—";
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / Math.pow(1024, idx);
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function relTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const diff = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return diff >= 0 ? `${abs} 秒后` : `${abs} 秒前`;
  const m = Math.round(abs / 60);
  if (m < 60) return diff >= 0 ? `${m} 分钟后` : `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return diff >= 0 ? `${h} 小时后` : `${h} 小时前`;
  const d = Math.round(h / 24);
  return diff >= 0 ? `${d} 天后` : `${d} 天前`;
}

export const RUN_STATUS_META = {
  queued: { label: "排队中", cls: "info" },
  running: { label: "运行中", cls: "info" },
  success: { label: "成功", cls: "ok" },
  partial: { label: "部分失败", cls: "warn" },
  auth_error: { label: "认证失效", cls: "err" },
  failed: { label: "失败", cls: "err" },
  canceled: { label: "已中止", cls: "neutral" },
  cancelled: { label: "已中止", cls: "neutral" },
};

export function statusBadge(status) {
  const meta = RUN_STATUS_META[status] || { label: status || "未知", cls: "neutral" };
  return el("span", { class: `fl-badge ${meta.cls}` }, meta.label);
}

export const HEALTH_META = {
  ok: { label: "有效", cls: "ok" },
  warn: { label: "需留意", cls: "warn" },
  error: { label: "已失效", cls: "err" },
  unknown: { label: "未配置", cls: "neutral" },
};

export function healthBadge(health, textOverride = "") {
  const meta = HEALTH_META[health] || HEALTH_META.unknown;
  return el("span", { class: `fl-badge ${meta.cls}` }, textOverride || meta.label);
}

export function toast(message, variant = "info", duration = 3400) {
  const root = document.getElementById("toast-root") || document.getElementById("toast-region");
  if (!root) return;
  const node = el("div", { class: `fl-toast${variant === "danger" || variant === "err" ? " danger" : ""}` }, message);
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity 160ms ease";
    setTimeout(() => node.remove(), 180);
  }, duration);
}

export function confirmModal({ title = "确认操作", message = "确定继续吗？", okText = "确定", danger = false } = {}) {
  const dlg = document.getElementById("confirm-dialog");
  const titleEl = document.getElementById("confirm-dialog-title");
  const msgEl = document.getElementById("confirm-dialog-message");
  const okBtn = document.getElementById("confirm-dialog-ok");
  if (!dlg || typeof dlg.showModal !== "function") {
    return Promise.resolve(window.confirm(message));
  }
  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = okText;
  okBtn.className = danger ? "fl-btn danger" : "fl-btn accent";

  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      resolve(dlg.returnValue === "confirm");
    };
    dlg.addEventListener("close", onClose);
    dlg.returnValue = "cancel";
    dlg.showModal();
  });
}

export async function copyText(text, successMsg = "已复制到剪贴板") {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg);
  } catch {
    const ta = el("textarea", {
      value: text,
      style: { position: "fixed", opacity: "0", pointerEvents: "none" },
    });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(successMsg);
  }
}

export function positionPopoverFallback(popEl, triggerEl) {
  if (!popEl || !triggerEl) return;
  popEl.style.position = "";
  popEl.style.insetBlockStart = "";
  popEl.style.insetInlineStart = "";
  popEl.style.insetInlineEnd = "";
  popEl.style.insetBlockEnd = "";
  popEl.style.margin = "";

  requestAnimationFrame(() => {
    const pr = popEl.getBoundingClientRect();
    const tr = triggerEl.getBoundingClientRect();
    const offscreen = pr.right > window.innerWidth - 6 || pr.bottom > window.innerHeight - 6;
    const pinnedTopLeft = pr.left <= 24 && tr.left > 160;
    if (offscreen || pinnedTopLeft || !CSS.supports("position-area", "block-end")) {
      const top = Math.min(tr.bottom + 8, Math.max(8, window.innerHeight - pr.height - 8));
      const right = Math.max(8, window.innerWidth - tr.right);
      popEl.style.position = "fixed";
      popEl.style.margin = "0";
      popEl.style.insetBlockStart = `${Math.round(top)}px`;
      popEl.style.insetInlineEnd = `${Math.round(right)}px`;
      popEl.style.insetInlineStart = "auto";
    }
  });
}

export const SITE_DOMAINS = {
  twitter: ["twitter.com", "x.com", "mobile.twitter.com", "pbs.twimg.com", "t.co"],
  bluesky: ["bsky.app", "bsky.social"],
  pixiv: ["pixiv.net", "pximg.net"],
  fanbox: ["fanbox.cc"],
  patreon: ["patreon.com"],
  rule34: ["rule34.xxx"],
  instagram: ["instagram.com"],
  deviantart: ["deviantart.com"],
  danbooru: ["danbooru.donmai.us"],
  kemonoparty: ["kemono.su", "kemono.party", "coomer.su"],
  reddit: ["reddit.com", "redd.it"],
  tumblr: ["tumblr.com"],
  weibo: ["weibo.com", "weibo.cn"],
  gelbooru: ["gelbooru.com"],
  e621: ["e621.net"],
  misskey: ["misskey.io"],
  bilibili: ["bilibili.com", "b23.tv"],
};

export const SITE_LABELS = {
  twitter: "Twitter / X",
  bluesky: "Bluesky",
  pixiv: "Pixiv",
  fanbox: "Pixiv FANBOX",
  patreon: "Patreon",
  rule34: "Rule34",
  instagram: "Instagram",
  deviantart: "DeviantArt",
  danbooru: "Danbooru",
  kemonoparty: "Kemono",
  reddit: "Reddit",
  tumblr: "Tumblr",
  weibo: "微博 Weibo",
  gelbooru: "Gelbooru",
  e621: "e621",
  misskey: "Misskey",
  bilibili: "Bilibili",
};

export function detectSiteFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let host = "";
  try {
    const normalized = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    host = new URL(normalized).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (!host) return "";
  for (const [site, domains] of Object.entries(SITE_DOMAINS)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) {
      return site;
    }
  }
  return "";
}

export function debounce(fn, wait = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
