import { el, copyText } from "../util.js";

const ROW_HEIGHT = 22;
const OVERSCAN = 12;

function classifyLine(text) {
  const s = text || "";
  if (/\b(ERROR|CRITICAL|FATAL|HTTP\s+401|HTTP\s+403|AuthError|Exception)\b/i.test(s) || s.startsWith("[err]")) {
    return "vlog-err";
  }
  if (/\b(WARNING|WARN|429|retry)\b/i.test(s)) {
    return "vlog-warn";
  }
  if (/^\s*#|\b(100%|saved|downloaded|downloaded\s+\d+)\b/i.test(s) || s.startsWith("+ ")) {
    return "vlog-ok";
  }
  if (/\b(skip|skipped|abort|already exists)\b/i.test(s) || s.startsWith("[skip]")) {
    return "vlog-skip";
  }
  if (s.startsWith("[") || s.startsWith("> ")) {
    return "vlog-meta";
  }
  return "";
}

/**
 * Virtualized 22px-row log viewer with search, level filtering, auto-scroll & copy/download.
 */
export function createLogViewer({ runId = null } = {}) {
  let allLines = [];
  let filtered = [];
  let query = "";
  let filterMode = "all"; // "all" | "err" | "ok" | "skip"
  let autoFollow = true;
  let rafId = null;

  const searchInput = el("input", {
    type: "search",
    placeholder: "搜索日志关键字…",
    "aria-label": "搜索日志关键字",
    onInput: (e) => {
      query = e.target.value.trim().toLowerCase();
      applyFilter();
    },
  });

  const filterSelect = el(
    "select",
    {
      "aria-label": "日志级别过滤",
      onChange: (e) => {
        filterMode = e.target.value;
        applyFilter();
      },
    },
    el("option", { value: "all" }, "全部日志"),
    el("option", { value: "err" }, "仅错误/警告"),
    el("option", { value: "ok" }, "仅新增下载"),
    el("option", { value: "skip" }, "仅跳过/Archive")
  );

  const followToggle = el("input", {
    type: "checkbox",
    role: "switch",
    switch: true,
    checked: true,
    onChange: (e) => {
      autoFollow = e.target.checked;
      if (autoFollow) scrollToBottom();
    },
  });

  const countBadge = el("span", { class: "fl-badge neutral" }, "0 行");

  const toolbar = el(
    "div",
    { class: "vlog-toolbar" },
    searchInput,
    filterSelect,
    el("label", { class: "switch-inline xs" }, followToggle, el("span", null, "自动跟随")),
    countBadge,
    el(
      "button",
      {
        type: "button",
        class: "fl-btn subtle xs",
        onClick: () => copyText(filtered.join("\n"), `已复制 ${filtered.length} 行日志`),
      },
      "复制日志"
    ),
    runId
      ? el(
          "a",
          {
            class: "fl-btn subtle xs",
            href: `/api/runs/${encodeURIComponent(runId)}/log?download=1`,
            target: "_blank",
            rel: "noopener",
          },
          "下载完整日志"
        )
      : null
  );

  const windowEl = el("div", { class: "vlog-window" });
  const canvasEl = el("div", { class: "vlog-canvas" }, windowEl);
  const viewportEl = el("div", { class: "vlog-viewport", tabindex: "0", "aria-label": "运行日志输出" }, canvasEl);

  viewportEl.addEventListener("scroll", () => {
    const nearBottom = viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight < ROW_HEIGHT * 2;
    if (!nearBottom && autoFollow) {
      autoFollow = false;
      followToggle.checked = false;
    } else if (nearBottom && !autoFollow) {
      autoFollow = true;
      followToggle.checked = true;
    }
    scheduleRender();
  });

  function matchesFilter(line) {
    if (query && !line.toLowerCase().includes(query)) return false;
    if (filterMode === "all") return true;
    const cls = classifyLine(line);
    if (filterMode === "err") return cls === "vlog-err" || cls === "vlog-warn";
    if (filterMode === "ok") return cls === "vlog-ok";
    if (filterMode === "skip") return cls === "vlog-skip";
    return true;
  }

  function applyFilter() {
    filtered = allLines.filter(matchesFilter);
    canvasEl.style.height = `${Math.max(filtered.length * ROW_HEIGHT, 64)}px`;
    countBadge.textContent =
      filtered.length === allLines.length
        ? `${allLines.length} 行`
        : `${filtered.length} / ${allLines.length} 行`;
    renderWindow();
    if (autoFollow) scrollToBottom();
  }

  function scrollToBottom() {
    viewportEl.scrollTop = Math.max(0, canvasEl.offsetHeight - viewportEl.clientHeight);
  }

  function renderWindow() {
    rafId = null;
    if (!filtered.length) {
      windowEl.style.transform = "translateY(0px)";
      windowEl.innerHTML = "";
      windowEl.appendChild(
        el("div", { class: "vlog-line muted" }, allLines.length ? "当前过滤条件无匹配日志" : "暂无日志输出")
      );
      return;
    }

    const viewH = viewportEl.clientHeight || 440;
    const scrollTop = viewportEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewH / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(filtered.length, start + visibleCount);

    windowEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const line = filtered[i];
      const cls = classifyLine(line);
      frag.appendChild(el("div", { class: `vlog-line${cls ? " " + cls : ""}` }, line));
    }
    windowEl.replaceChildren(frag);
  }

  function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(renderWindow);
  }

  const root = el("div", { class: "stack sm-gap" }, toolbar, viewportEl);

  return {
    el: root,
    setLines(lines = []) {
      allLines = Array.isArray(lines) ? [...lines] : String(lines || "").split(/\r?\n/);
      applyFilter();
    },
    appendLines(lines = []) {
      const add = Array.isArray(lines) ? lines : [String(lines)];
      if (!add.length) return;
      for (const l of add) {
        allLines.push(l);
        if (matchesFilter(l)) filtered.push(l);
      }
      canvasEl.style.height = `${Math.max(filtered.length * ROW_HEIGHT, 64)}px`;
      countBadge.textContent =
        filtered.length === allLines.length
          ? `${allLines.length} 行`
          : `${filtered.length} / ${allLines.length} 行`;
      scheduleRender();
      if (autoFollow) requestAnimationFrame(scrollToBottom);
    },
    destroy() {
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
  };
}
