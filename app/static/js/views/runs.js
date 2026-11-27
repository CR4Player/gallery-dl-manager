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
  fmtBytes,
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
    const items = res?.runs || res?.items || (Array.isArray(res) ? res : []);
    runs = append ? [...runs, ...items] : items;
    hasMore = Boolean(res?.has_more ?? items.length >= 30);
    loadMoreBtn.classList.toggle("hidden", !hasMore);

    if (!selectedId && runs.length && window.innerWidth >= 880) {
      selectedId = String(runs[0].id);
    }
  }

  function renderRunList() {
    listCardsEl.innerHTML = "";
    const filtered = runs.filter((r) => {
      if (!searchQuery) return true;
      const hay = `${r.id} ${r.task_name || ""} ${r.label || ""} ${r.trigger_source || ""}`.toLowerCase();
      return hay.includes(searchQuery);
    });

    if (!filtered.length) {
      listCardsEl.appendChild(el("div", { class: "empty-state" }, "暂无匹配运行记录"));
      return;
    }

    for (const r of filtered) {
      const isActive = String(r.id) === String(selectedId);
      const titleText = `#${r.id} ${r.task_name || r.label || "即时下载"}`;
      const metaText = `+${r.files_downloaded ?? 0} 新增 · ${r.files_skipped ?? 0} 跳过 · ${fmtTimeShort(r.created_at)}`;
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

    let run = null;
    try {
      const res = await api.get(`/api/runs/${encodeURIComponent(runId)}`);
      run = res?.run || res;
    } catch (err) {
      detailPaneEl.replaceChildren(el("div", { class: "fl-infobar danger" }, `读取运行详情失败：${err.message}`));
      return;
    }
    if (destroyed || String(selectedId) !== String(runId)) return;

    const isLive = ACTIVE_STATUSES.has(run.status);
    const statDownloaded = el("strong", null, String(run.files_downloaded ?? 0));
    const statSkipped = el("strong", null, String(run.files_skipped ?? 0));
    const statFailed = el("strong", null, String(run.files_failed ?? 0));
    const statDuration = el("strong", null, isLive ? "进行中" : fmtDuration(run.duration_seconds));

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
          el("h2", { style: { margin: 0, fontSize: "1.1rem" } }, `#${run.id} ${run.task_name || run.label || "下载运行"}`)
        ),
        headerActions
      ),
      el(
        "div",
        { class: "muted xs row-actions", style: { gap: "0.75rem" } },
        el("span", null, `触发方式: ${run.trigger_source || (run.simulate ? "模拟试跑" : "手动/定时")}`),
        el("span", null, `开始: ${fmtTime(run.started_at || run.created_at)}`),
        run.finished_at ? el("span", null, `结束: ${fmtTime(run.finished_at)}`) : null,
        run.bytes_downloaded ? el("span", null, `流量: ${fmtBytes(run.bytes_downloaded)}`) : null
      ),
      run.error_summary
        ? el("div", { class: "fl-infobar danger sm" }, run.error_summary)
        : null,
      el(
        "div",
        { class: "stats-grid" },
        el("div", { class: "fl-stat-card ok" }, el("span", { class: "fl-stat-label" }, "新增下载"), statDownloaded),
        el("div", { class: "fl-stat-card" }, el("span", { class: "fl-stat-label" }, "Archive / 已存在跳过"), statSkipped),
        el("div", { class: `fl-stat-card${(run.files_failed || 0) > 0 ? " err" : ""}` }, el("span", { class: "fl-stat-label" }, "错误数量"), statFailed),
        el("div", { class: "fl-stat-card" }, el("span", { class: "fl-stat-label" }, "执行耗时"), statDuration)
      ),
      viewer.el
    );

    detailPaneEl.replaceChildren(detailBody);

    if (isLive && typeof EventSource !== "undefined") {
      const es = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/stream?tail=800`);
      activeEs = es;

      es.addEventListener("log_snapshot", (ev) => {
        try {
          const d = JSON.parse(ev.data);
          viewer.setLines(d?.lines || []);
        } catch {
          // ignore
        }
      });
      es.addEventListener("log", (ev) => {
        try {
          const d = JSON.parse(ev.data);
          const lines = d?.lines || (d?.line !== undefined ? [d.line] : []);
          if (lines.length) viewer.appendLines(lines);
        } catch {
          if (ev.data) viewer.appendLines([ev.data]);
        }
      });
      es.addEventListener("stats", (ev) => {
        try {
          const st = JSON.parse(ev.data);
          if (st.files_downloaded !== undefined) statDownloaded.textContent = String(st.files_downloaded);
          if (st.files_skipped !== undefined) statSkipped.textContent = String(st.files_skipped);
          if (st.files_failed !== undefined) statFailed.textContent = String(st.files_failed);
        } catch {
          // ignore
        }
      });
      es.addEventListener("done", () => {
        es.close();
        activeEs = null;
        fetchRuns(false).then(renderRunList).catch(() => {});
        loadRunDetail(run.id);
        ctx?.refreshHeader?.();
      });
    } else {
      try {
        const logRes = await api.get(`/api/runs/${encodeURIComponent(run.id)}/log`);
        if (destroyed || String(selectedId) !== String(run.id)) return;
        const rawLines = Array.isArray(logRes?.lines)
          ? logRes.lines
          : typeof logRes === "string"
            ? logRes.split(/\r?\n/)
            : (logRes?.content || "").split(/\r?\n/);
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
    el("option", { value: "canceled", selected: statusFilter === "canceled" }, "已中止")
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
          el("div", { class: "muted xs" }, "主从双栏视图 · 支持 5000+ 行虚拟化日志滚动与实时 SSE 推送")
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
