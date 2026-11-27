import { api } from "../api.js";
import { events } from "../events.js";
import {
  el,
  toast,
  confirmModal,
  statusBadge,
  fmtTime,
  fmtTimeShort,
  fmtDuration,
} from "../util.js";
import { navigate } from "../router.js";
import { createLogViewer } from "../components/log-viewer.js";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export async function renderRuns(container, route, ctx) {
  let destroyed = false;
  let activeEs = null;
  let activeViewer = null;

  let runs = [];
  let selectedId = route.id ? String(route.id) : null;
  let statusFilter = route.params?.status || "";
  let searchQuery = "";
  let hasMore = false;

  const listCardsEl = el("div", { class: "run-cards" });
  const detailPaneEl = el("div", { class: "fl-card stack runs-detail-pane" });
  const layoutEl = el("div", { class: `runs-layout${selectedId ? " has-selected" : ""}` });
  const loadMoreBtn = el("button", { type: "button", class: "fl-btn subtle sm full hidden" }, "加载更早记录");

  function closeStream() {
    if (activeEs) {
      activeEs.close();
      activeEs = null;
    }
    if (activeViewer) {
      activeViewer.destroy();
      activeViewer = null;
    }
  }

  async function fetchRuns(append = false) {
    const params = new URLSearchParams({ limit: "30" });
    if (statusFilter) params.set("status", statusFilter);
    if (append && runs.length) params.set("before_id", String(runs[runs.length - 1].id));

    const res = await api.get(`/api/runs?${params.toString()}`);
    if (destroyed) return;
    const items = Array.isArray(res?.runs) ? res.runs : [];
    runs = append ? [...runs, ...items] : items;
    const total = Number(res?.total ?? items.length);
    hasMore = runs.length < total && items.length >= 30;
    loadMoreBtn.classList.toggle("hidden", !hasMore);

    if (!selectedId && runs.length && window.innerWidth >= 880) {
      selectedId = String(runs[0].id);
    }
  }

  function renderRunList() {
    listCardsEl.innerHTML = "";
    const filtered = runs.filter((r) => {
      if (!searchQuery) return true;
      const hay = `${r.id} ${r.task_name || ""} ${r.trigger_type || ""}`.toLowerCase();
      return hay.includes(searchQuery);
    });

    if (!filtered.length) {
      listCardsEl.appendChild(el("div", { class: "empty-state" }, "暂无匹配运行记录"));
      return;
    }

    for (const r of filtered) {
      const isActive = String(r.id) === String(selectedId);
      const titleText = `#${r.id} ${r.task_name || "即时下载"}`;
      const metaText = `+${r.downloaded_count ?? 0} 新增 · ${r.skipped_count ?? 0} 跳过 · ${fmtTimeShort(r.created_at)}`;
      listCardsEl.appendChild(
        el(
          "a",
          {
            class: `run-item${isActive ? " active" : ""}`,
            href: `#runs/${r.id}`,
            onClick: (e) => {
              e.preventDefault();
              selectedId = String(r.id);
              layoutEl.classList.add("has-selected");
              history.replaceState(null, "", `#runs/${r.id}`);
              renderRunList();
              loadRunDetail(selectedId);
            },
          },
          el(
            "div",
            { class: "run-item-top" },
            el("span", { class: "run-item-title", title: titleText }, titleText),
            statusBadge(r.status)
          ),
          el("div", { class: "run-item-meta" }, metaText)
        )
      );
    }
  }

  async function loadRunDetail(runId) {
    closeStream();
    if (!runId) {
      detailPaneEl.replaceChildren(el("div", { class: "empty-state" }, "在左侧选择一次运行以查看详细统计与实时日志。"));
      return;
    }
    detailPaneEl.replaceChildren(el("div", { class: "fl-infobar" }, `正在载入 Run #${runId} 详情与日志…`));

    let detail = null;
    try {
      detail = await api.get(`/api/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      detailPaneEl.replaceChildren(el("div", { class: "fl-infobar danger" }, `读取运行详情失败：${err.message}`));
      return;
    }
    if (destroyed || String(selectedId) !== String(runId)) return;

    const run = detail?.run || detail;
    const filesList = Array.isArray(detail?.files) ? detail.files : [];
    const isLive = ACTIVE_STATUSES.has(run.status);

    const statDownloaded = el("strong", null, String(run.downloaded_count ?? 0));
    const statSkipped = el("strong", null, String(run.skipped_count ?? 0));
    const statWarn = el("strong", null, String(run.postprocess_warn ?? 0));
    const statDuration = el("strong", null, isLive ? "进行中" : fmtDuration(run.duration_sec));

    const headerActions = el("div", { class: "row-actions" });
    if (isLive) {
      headerActions.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "fl-btn danger sm",
            onClick: async () => {
              const ok = await confirmModal({ title: "中止运行", message: `确定中止 Run #${run.id} 吗？`, okText: "中止", danger: true });
              if (!ok) return;
              await api.post(`/api/runs/${run.id}/cancel`, {});
              toast(`已发送中止信号 Run #${run.id}`);
              loadRunDetail(run.id);
            },
          },
          "中止运行"
        )
      );
    } else {
      headerActions.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "fl-btn sm",
            onClick: async () => {
              const res = await api.post(`/api/runs/${run.id}/retry`, {});
              toast(res?.run_id ? `已创建重试 Run #${res.run_id}` : "已加入重试队列");
              if (res?.run_id) navigate(`#runs/${res.run_id}`);
            },
          },
          "重新运行"
        )
      );
    }
    if (run.task_id) {
      headerActions.appendChild(
        el("a", { class: "fl-btn subtle sm", href: `#task/${run.task_id}` }, "所属任务")
      );
    }

    const viewer = createLogViewer({ runId: run.id });
    activeViewer = viewer;

    const truncNotice = detail?.log_truncated
      ? el(
          "div",
          { class: "fl-infobar sm", style: { justifyContent: "space-between" } },
          el("span", null, "日志较长，当前仅显示末尾 500 行摘要。"),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle xs",
              onClick: async () => {
                const raw = await api.get(`/api/runs/${encodeURIComponent(run.id)}/log`);
                const lines = String(raw || "").split(/\r?\n/);
                viewer.setLines(lines.filter((l, idx, arr) => idx < arr.length - 1 || l !== ""));
                truncNotice.classList.add("hidden");
              },
            },
            "加载完整日志"
          )
        )
      : null;

    const filesCard = filesList.length
      ? el(
          "details",
          { class: "fl-expander" },
          el("summary", { class: "fl-expander-head" }, `本次下载文件清单 (${filesList.length})`),
          el(
            "div",
            { class: "fl-expander-body stack xs-gap", style: { maxBlockSize: "200px", overflow: "auto" } },
            ...filesList.slice(0, 100).map((f) =>
              el("div", { class: "xs muted", style: { fontFamily: "var(--fl-mono)", wordBreak: "break-all" } }, f.file_path || "")
            )
          )
        )
      : null;

    const detailBody = el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          { class: "row-actions" },
          el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle sm runs-back-btn",
              onClick: () => layoutEl.classList.remove("has-selected"),
            },
            "← 列表"
          ),
          statusBadge(run.status),
          el("h2", { style: { margin: 0, fontSize: "1.1rem" } }, `#${run.id} ${run.task_name || "下载运行"}`)
        ),
        headerActions
      ),
      el(
        "div",
        { class: "muted xs row-actions", style: { gap: "0.75rem", flexWrap: "wrap" } },
        el("span", null, `触发方式: ${run.trigger_type || "manual"}${run.simulate ? " (模拟)" : ""}`),
        el("span", null, `开始: ${fmtTime(run.started_at || run.created_at)}`),
        run.finished_at ? el("span", null, `结束: ${fmtTime(run.finished_at)}`) : null,
        run.exit_code !== null && run.exit_code !== undefined ? el("span", null, `ExitCode: ${run.exit_code}`) : null
      ),
      run.error_summary
        ? el("div", { class: "fl-infobar danger sm" }, run.error_summary)
        : null,
      el(
        "div",
        { class: "stats-grid" },
        el("div", { class: "fl-stat-card ok" }, el("span", { class: "fl-stat-label" }, "新增下载"), statDownloaded),
        el("div", { class: "fl-stat-card" }, el("span", { class: "fl-stat-label" }, "Archive / 已存在跳过"), statSkipped),
        el("div", { class: `fl-stat-card${(run.postprocess_warn || 0) > 0 ? " warn" : ""}` }, el("span", { class: "fl-stat-label" }, "后处理告警"), statWarn),
        el("div", { class: "fl-stat-card" }, el("span", { class: "fl-stat-label" }, "执行耗时"), statDuration)
      ),
      filesCard,
      truncNotice,
      viewer.el
    );

    detailPaneEl.replaceChildren(detailBody);

    if (isLive && typeof EventSource !== "undefined") {
      const es = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/stream?tail=800`);
      activeEs = es;

      // Backend /api/runs/{id}/stream emits unnamed `data: {"type": "...", ...}` frames
      es.onmessage = (ev) => {
        if (!ev.data) return;
        let d = null;
        try {
          d = JSON.parse(ev.data);
        } catch {
          viewer.appendLines([ev.data]);
          return;
        }
        if (d.type === "log_snapshot") {
          viewer.setLines(d.lines || []);
        } else if (d.type === "log") {
          const lines = d.lines || (d.line !== undefined ? [d.line] : []);
          if (lines.length) viewer.appendLines(lines);
        } else if (d.type === "stats") {
          if (d.downloaded_count !== undefined) statDownloaded.textContent = String(d.downloaded_count);
          if (d.skipped_count !== undefined) statSkipped.textContent = String(d.skipped_count);
          if (d.postprocess_warn !== undefined) statWarn.textContent = String(d.postprocess_warn);
          if (d.duration_sec !== undefined) statDuration.textContent = fmtDuration(d.duration_sec);
        } else if (d.type === "done") {
          es.close();
          activeEs = null;
          fetchRuns(false).then(renderRunList).catch(() => {});
          loadRunDetail(run.id);
          ctx?.refreshHeader?.();
        }
      };
    } else if (Array.isArray(detail?.log_lines) && detail.log_lines.length) {
      viewer.setLines(detail.log_lines);
    } else {
      try {
        const rawLog = await api.get(`/api/runs/${encodeURIComponent(run.id)}/log`);
        if (destroyed || String(selectedId) !== String(run.id)) return;
        const rawLines = typeof rawLog === "string" ? rawLog.split(/\r?\n/) : [];
        viewer.setLines(rawLines.filter((l, i, arr) => i < arr.length - 1 || l !== ""));
      } catch (err) {
        viewer.setLines([`[err] 读取日志失败: ${err.message}`]);
      }
    }
  }

  await fetchRuns(false);
  if (destroyed) return;

  const statusSel = el(
    "select",
    {
      "aria-label": "按状态筛选运行记录",
      onChange: async (e) => {
        statusFilter = e.target.value;
        await fetchRuns(false);
        renderRunList();
        if (selectedId) loadRunDetail(selectedId);
      },
    },
    el("option", { value: "", selected: statusFilter === "" }, "全部状态"),
    el("option", { value: "running", selected: statusFilter === "running" }, "运行中"),
    el("option", { value: "queued", selected: statusFilter === "queued" }, "排队中"),
    el("option", { value: "success", selected: statusFilter === "success" }, "成功"),
    el("option", { value: "partial", selected: statusFilter === "partial" }, "部分失败"),
    el("option", { value: "auth_error", selected: statusFilter === "auth_error" }, "认证失效"),
    el("option", { value: "failed", selected: statusFilter === "failed" }, "失败"),
    el("option", { value: "cancelled", selected: statusFilter === "cancelled" }, "已中止")
  );

  loadMoreBtn.addEventListener("click", async () => {
    await fetchRuns(true);
    renderRunList();
  });

  const leftPane = el(
    "div",
    { class: "fl-card stack sm-gap runs-list-pane" },
    statusSel,
    el("input", {
      type: "search",
      placeholder: "筛选运行 ID 或任务名…",
      onInput: (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        renderRunList();
      },
    }),
    listCardsEl,
    loadMoreBtn
  );

  layoutEl.append(leftPane, detailPaneEl);
  if (selectedId) layoutEl.classList.add("has-selected");

  container.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          null,
          el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.35rem" } }, "运行与日志"),
          el("div", { class: "muted xs" }, "主从双栏视图 · 支持虚拟化日志滚动与实时 SSE 推送")
        ),
        el(
          "button",
          {
            type: "button",
            class: "fl-btn sm",
            onClick: async () => {
              await fetchRuns(false);
              renderRunList();
              if (selectedId) loadRunDetail(selectedId);
            },
          },
          "刷新记录"
        )
      ),
      layoutEl
    )
  );

  renderRunList();
  loadRunDetail(selectedId);

  const onListChange = async () => {
    if (destroyed) return;
    await fetchRuns(false).catch(() => {});
    renderRunList();
  };
  const unsubs = [
    events.on("run_queued", onListChange),
    events.on("run_started", onListChange),
    events.on("run_finished", onListChange),
  ];

  return () => {
    destroyed = true;
    closeStream();
    unsubs.forEach((u) => u());
  };
}
