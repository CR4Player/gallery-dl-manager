import { esc, upgradeSwitches } from "../util.js";

const ROW_HEIGHT = 22;
const OVERSCAN = 30;

function classifyLine(line) {
  if (/\[error\]|ChallengeError|HttpError|HTTP\/\d\.\d"\s+[45]\d\d|\b(401|403|429|500|502|503)\b|Unauthorized|Forbidden/i.test(line)) {
    return "vlog-err";
  }
  if (/\[warning\]|\[warn\]|\[postprocess\]\[warn\]/i.test(line)) {
    return "vlog-warn";
  }
  if (line.startsWith("# ")) {
    return "vlog-skip";
  }
  if (/\[postprocess\]\[ok\]/i.test(line) || (line.startsWith("/") && !line.startsWith("//")) || /^[A-Za-z]:\\/.test(line)) {
    return "vlog-ok";
  }
  if (/^\[(\d{4}-\d{2}-\d{2}|cmd|manager)\]/.test(line) || line.includes("=====")) {
    return "vlog-meta";
  }
  return "";
}

/**
 * Fixed-row-height virtualized log viewer supporting up to 5000 lines, search,
 * level filtering, coloring, and sticky auto-scroll.
 */
export function createLogViewer(container, { maxLines = 5000 } = {}) {
  const uid = Math.random().toString(36).slice(2, 8);
  let allLines = [];
  let filtered = [];
  let truncated = false;
  let rafPending = false;

  container.innerHTML = `
    <div class="stack sm-gap">
      <div class="log-toolbar">
        <input type="search" id="vl-search-${uid}" placeholder="过滤日志关键词…" aria-label="过滤日志关键词">
        <select id="vl-mode-${uid}" aria-label="日志过滤级别" style="width:auto;">
          <option value="all">全部日志</option>
          <option value="errors">仅错误与警告</option>
          <option value="files">仅新增文件</option>
        </select>
        <label class="checkbox-inline">
          <input type="checkbox" switch role="switch" id="vl-autoscroll-${uid}" checked> 自动滚底
        </label>
        <span id="vl-count-${uid}" class="muted xs">0 行</span>
      </div>
      <div id="vl-hint-${uid}" class="notice info sm hidden"></div>
      <div id="vl-viewport-${uid}" class="vlog-viewport" tabindex="0" aria-live="off">
        <div id="vl-canvas-${uid}" class="vlog-canvas">
          <div id="vl-window-${uid}" class="vlog-window"></div>
        </div>
      </div>
    </div>
  `;
  upgradeSwitches(container);

  const searchEl = document.getElementById(`vl-search-${uid}`);
  const modeEl = document.getElementById(`vl-mode-${uid}`);
  const autoScrollEl = document.getElementById(`vl-autoscroll-${uid}`);
  const countEl = document.getElementById(`vl-count-${uid}`);
  const hintEl = document.getElementById(`vl-hint-${uid}`);
  const viewport = document.getElementById(`vl-viewport-${uid}`);
  const canvas = document.getElementById(`vl-canvas-${uid}`);
  const winEl = document.getElementById(`vl-window-${uid}`);

  function recomputeFilter() {
    const q = searchEl.value.trim().toLowerCase();
    const mode = modeEl.value;
    filtered = allLines.filter((line) => {
      if (q && !line.toLowerCase().includes(q)) return false;
      if (mode === "errors") {
        const cls = classifyLine(line);
        return cls === "vlog-err" || cls === "vlog-warn";
      }
      if (mode === "files") {
        return classifyLine(line) === "vlog-ok" && !line.startsWith("[postprocess]");
      }
      return true;
    });
    countEl.textContent = filtered.length === allLines.length
      ? `${allLines.length} 行`
      : `${filtered.length} / ${allLines.length} 行`;
  }

  function renderWindow() {
    if (truncated) {
      hintEl.textContent = `当前仅滚动展示最近 ${allLines.length} 行日志，完整记录请点击右上角「下载日志」`;
      hintEl.classList.remove("hidden");
    } else {
      hintEl.classList.add("hidden");
    }

    const total = filtered.length;
    canvas.style.height = `${Math.max(ROW_HEIGHT, total * ROW_HEIGHT)}px`;
    if (total === 0) {
      winEl.style.transform = "translateY(0px)";
      winEl.innerHTML = `<div class="vlog-line muted">暂无匹配的日志内容</div>`;
      return;
    }

    const viewH = viewport.clientHeight || 420;
    const scrollTop = viewport.scrollTop;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewH / ROW_HEIGHT) + OVERSCAN * 2;
    const endIdx = Math.min(total, startIdx + visibleCount);

    winEl.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;
    const htmlParts = [];
    for (let i = startIdx; i < endIdx; i++) {
      const ln = filtered[i];
      const cls = classifyLine(ln);
      htmlParts.push(`<div class="vlog-line ${cls}">${esc(ln)}</div>`);
    }
    winEl.innerHTML = htmlParts.join("");
  }

  function scheduleRender(scrollToEnd = false) {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderWindow();
      if (scrollToEnd && autoScrollEl.checked) {
        viewport.scrollTop = viewport.scrollHeight;
        renderWindow();
      }
    });
  }

  viewport.addEventListener("scroll", () => renderWindow(), { passive: true });
  const ro = new ResizeObserver(() => renderWindow());
  ro.observe(viewport);

  searchEl.addEventListener("input", () => {
    recomputeFilter();
    renderWindow();
  });
  modeEl.addEventListener("change", () => {
    recomputeFilter();
    renderWindow();
  });

  return {
    setLines(lines, isTruncated = false) {
      const arr = Array.isArray(lines) ? lines : [];
      truncated = Boolean(isTruncated) || arr.length > maxLines;
      allLines = arr.slice(-maxLines);
      recomputeFilter();
      scheduleRender(true);
    },
    appendLine(line) {
      allLines.push(String(line ?? ""));
      if (allLines.length > maxLines) {
        allLines = allLines.slice(-maxLines);
        truncated = true;
      }
      recomputeFilter();
      scheduleRender(true);
    },
    getAllLines() {
      return allLines;
    },
    destroy() {
      ro.disconnect();
    },
  };
}
