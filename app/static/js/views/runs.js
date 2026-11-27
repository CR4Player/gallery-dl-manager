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
import { pageHead, cardHead, emptyState, infoBar } from "../ui.js";
import { icon } from "../icons.js";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export async function renderRuns(container, route, ctx) {
  let destroyed = false;
  let activeEs = null;
  let activeViewer = null;

  let runs = [];
  let selectedId = route.id ? String(route.id) : null;
  let statusFilter = route.params?.status || "";
  let taskIdFilter = route.params?.task_id || "";
  let searchQuery = "";
  let hasMore = false;

  const listCardsEl = el("div", { class: "run-cards" });
  const detailPaneEl = el("div", { class: "fl-card stack runs-detail-pane" });
  const layoutEl = el("div", { class: `runs-layout${selectedId ? " has-selected" : ""}` });
  const loadMoreBtn = el("button", { type: "button", class: "fl-btn subtle sm full hidden" }, "加载更早记录");
  const runCountEl = el("span", { class: "count-chip" }, "0");
  const taskFilterChip = el("div", { class: `row-actions between fl-sub-card${taskIdFilter ? "" : " hidden"}`, style: { padding: "6px 10px" } });

  function renderTaskFilterChip() {
    taskFilterChip.replaceChildren();
    if (!taskIdFilter) {
      taskFilterChip.classList.add("hidden");
      return;
    }
    taskFilterChip.classList.remove("hidden");
    taskFilterChip.append(
      el("span", { class: "xs" }, `仅显示任务 #${taskIdFilter} 的运行记录`),
      el(
        "button",
        {
          type: "button",
          class: "fl-btn subtle xs",
          onClick: async () => {
            taskIdFilter = "";
            renderTaskFilterChip();
            history.replaceState(null, "", selectedId ? `#runs/${selectedId}` : "#runs");
            try {
              await fetchRuns(false);
              renderRunList();
            } catch (err) {
              toast(`刷新运行记录失败：${err.message}`, "danger");
            }
          },
        },
        "清除筛选"
      )
    );
  }
  renderTaskFilterChip();

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

  async function fetchRuns(append = false, preserveCount = false) {
    const reqLimit = !append && preserveCount ? Math.min(200, Math.max(30, runs.length)) : 30;
    const params = new URLSearchParams({ limit: String(reqLimit) });
    if (statusFilter) params.set("status", statusFilter);
    if (taskIdFilter) params.set("task_id", taskIdFilter);
    if (append && runs.length) params.set("before_id", String(runs[runs.length - 1].id));

    const res = await api.get(`/api/runs?${params.toString()}`);
    if (destroyed) return;
    const items = Array.isArray(res?.runs) ? res.runs : [];
    runs = append ? [...runs, ...items] : items;
    const total = Number(res?.total ?? items.length);
    hasMore = runs.length < total && items.length >= reqLimit;
    loadMoreBtn.classList.toggle("hidden", !hasMore);
    runCountEl.textContent = String(runs.length);

    if (!selectedId && runs.length && window.innerWidth >= 900) {
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
      listCardsEl.appendChild(emptyState("尝试调整状态筛选或搜索关键字", "terminal", "暂无匹配运行记录"));
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
      detailPaneEl.replaceChildren(
        emptyState("在左侧选择一次运行，即可查看详细统计与实时日志。", "terminal", "选择一条运行记录")
      );
      return;
    }
    detailPaneEl.replaceChildren(
      el(
        "div",
        { class: "fl-infobar" },
        el("span", { class: "infobar-icon" }, el("span", { class: "spinner" })),
        el("div", { class: "infobar-body" }, `正在载入 Run #${runId} 详情与日志…`)
      )
    );

    let detail = null;
    try {
      detail = await api.get(`/api/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      detailPaneEl.replaceChildren(infoBar({ tone: "danger", title: "读取运行详情失败", body: err.message }));
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

    const runStat = (label, valueNode, tone, iconName) =>
      el(
        "div",
        { class: `fl-stat-card ${tone}`.trim() },
        el(
          "div",
          { class: "stat-top" },
          el("span", { class: `stat-icon ${tone}`.trim() }, icon(iconName, 15)),
          el("span", { class: "fl-stat-label" }, label)
        ),
        valueNode
      );

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
              try {
                await api.post(`/api/runs/${run.id}/cancel`, {});
                toast(`已发送中止信号 Run #${run.id}`);
                if (!activeEs) {
                  loadRunDetail(run.id);
                }
              } catch (err) {
                toast(`中止失败：${err.message}`, "danger");
              }
            },
          },
          icon("pause", 14),
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
              try {
                const res = await api.post(`/api/runs/${run.id}/retry`, {});
                if (res?.already_active) {
                  toast(`关联任务已在运行或排队中 (Run #${res.run_id})`);
                } else {
                  toast(res?.run_id ? `已创建重试 Run #${res.run_id}` : "已加入重试队列");
                }
                if (res?.run_id) navigate(`#runs/${res.run_id}`);
              } catch (err) {
                toast(`重新运行失败：${err.message}`, "danger");
              }
            },
          },
          icon("refresh", 14),
          "重新运行"
        )
      );
    }
    if (run.task_id) {
      headerActions.appendChild(el("a", { class: "fl-btn subtle sm", href: `#task/${run.task_id}` }, icon("calendar", 14), "所属任务"));
    }

    const viewer = createLogViewer({ runId: run.id });
    activeViewer = viewer;

    const sseNotice = el("div", { class: "fl-infobar warn sm hidden" });
    const truncNotice = infoBar({
      tone: "",
      title: "日志较长",
      body: "当前仅显示末尾摘要，可点击右侧按钮加载完整日志。",
      iconName: "file-text",
      actions: [
        el(
          "button",
          {
            type: "button",
            class: "fl-btn subtle sm",
            onClick: async () => {
              try {
                const raw = await api.get(`/api/runs/${encodeURIComponent(run.id)}/log`);
                const lines = String(raw || "").split(/\r?\n/);
                viewer.setLines(lines.filter((l, idx, arr) => idx < arr.length - 1 || l !== ""));
                truncNotice.classList.add("hidden");
              } catch (err) {
                toast(`加载完整日志失败：${err.message}`, "danger");
              }
            },
          },
          "加载完整日志"
        ),
      ],
    });
    if (!detail?.log_truncated) {
      truncNotice.classList.add("hidden");
    }

    const liveFiles = filesList.map((f) => f.file_path || "").filter(Boolean);
    let showAllFiles = false;
    const filesSummaryEl = el("summary", { class: "fl-expander-head" }, `本次下载文件清单 (${liveFiles.length})`);
    const filesBodyEl = el("div", { class: "fl-expander-body stack xs-gap", style: { maxBlockSize: "240px", overflow: "auto" } });
    const filesCard = el("details", { class: `fl-expander${liveFiles.length ? "" : " hidden"}` }, filesSummaryEl, filesBodyEl);

    function renderFilesCard() {
      if (!liveFiles.length) {
        filesCard.classList.add("hidden");
        return;
      }
      filesCard.classList.remove("hidden");
      filesSummaryEl.textContent = `本次下载文件清单 (${liveFiles.length})`;
      const limit = showAllFiles ? liveFiles.length : 100;
      const nodes = liveFiles.slice(0, limit).map((fp) => el("div", { class: "file-path-row" }, el("span", null, fp)));
      if (!showAllFiles && liveFiles.length > 100) {
        nodes.push(
          el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle xs",
              onClick: () => {
                showAllFiles = true;
                renderFilesCard();
              },
            },
            `显示全部 (共 ${liveFiles.length} 条，还有 ${liveFiles.length - 100} 条)`
          )
        );
      }
      filesBodyEl.replaceChildren(...nodes);
    }
    renderFilesCard();

    const detailBody = el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "run-detail-head" },
        el(
          "div",
          { class: "row-actions", style: { minWidth: 0 } },
          el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle sm runs-back-btn",
              onClick: () => layoutEl.classList.remove("has-selected"),
            },
            icon("arrow-left", 14),
            "列表"
          ),
          statusBadge(run.status),
          el("h2", { class: "page-title", style: { fontSize: "1.25rem" } }, `#${run.id} ${run.task_name || "下载运行"}`)
        ),
        headerActions
      ),
      el(
        "div",
        { class: "run-meta-line" },
        el("span", null, icon("zap", 13), `触发方式: ${run.trigger_type || "manual"}${run.simulate ? " (模拟)" : ""}`),
        el("span", null, icon("clock", 13), `开始: ${fmtTime(run.started_at || run.created_at)}`),
        run.finished_at ? el("span", null, `结束: ${fmtTime(run.finished_at)}`) : null,
        run.exit_code !== null && run.exit_code !== undefined ? el("span", null, `ExitCode: ${run.exit_code}`) : null
      ),
      run.error_summary ? infoBar({ tone: "danger", title: "运行异常", body: run.error_summary }) : null,
      el(
        "div",
        { class: "stats-grid" },
        runStat("新增下载", statDownloaded, "ok", "download"),
        runStat("Archive / 已存在跳过", statSkipped, "", "database"),
        runStat("后处理告警", statWarn, (run.postprocess_warn || 0) > 0 ? "warn" : "", "alert"),
        runStat("执行耗时", statDuration, "", "clock")
      ),
      filesCard,
      sseNotice,
      truncNotice,
      viewer.el
    );

    detailPaneEl.replaceChildren(detailBody);

    if (isLive && typeof EventSource !== "undefined") {
      const es = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/stream?tail=800`);
      activeEs = es;

      es.onopen = () => {
        sseNotice.classList.add("hidden");
      };

      es.onerror = () => {
        sseNotice.textContent = "实时日志连接暂时中断，浏览器正在自动重连…";
        sseNotice.classList.remove("hidden");
        fetch("/api/auth/status", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((st) => {
            if (st && !st.auth_disabled && !st.authenticated) {
              es.close();
              location.replace(st.configured ? "/login" : "/setup");
            }
          })
          .catch(() => {});
      };

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
          truncNotice.classList.toggle("hidden", !d.truncated);
        } else if (d.type === "log") {
          const lines = d.lines || (d.line !== undefined ? [d.line] : []);
          if (lines.length) viewer.appendLines(lines);
        } else if (d.type === "file" && d.file_path) {
          liveFiles.push(d.file_path);
          renderFilesCard();
        } else if (d.type === "stats") {
          if (d.downloaded_count !== undefined) statDownloaded.textContent = String(d.downloaded_count);
          if (d.skipped_count !== undefined) statSkipped.textContent = String(d.skipped_count);
          if (d.postprocess_warn !== undefined) statWarn.textContent = String(d.postprocess_warn);
          if (d.duration_sec !== undefined) statDuration.textContent = fmtDuration(d.duration_sec);
        } else if (d.type === "done") {
          es.close();
          activeEs = null;
          fetchRuns(false, true).then(renderRunList).catch(() => {});
          loadRunDetail(run.id);
          ctx?.refreshHeader?.();
        }
      };
    } else if (Array.isArray(detail?.log_lines)) {
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
        try {
          const prevSelected = selectedId;
          await fetchRuns(false);
          if (selectedId && runs.length && !runs.some((r) => String(r.id) === String(selectedId))) {
            selectedId = window.innerWidth >= 900 ? String(runs[0].id) : null;
          }
          renderRunList();
          if (selectedId !== prevSelected) {
            loadRunDetail(selectedId);
          }
        } catch (err) {
          toast(`筛选运行记录失败：${err.message}`, "danger");
        }
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
    try {
      await fetchRuns(true);
      renderRunList();
    } catch (err) {
      toast(`加载更多失败：${err.message}`, "danger");
    }
  });

  const leftPane = el(
    "div",
    { class: "fl-card stack sm-gap runs-list-pane", style: { padding: "12px" } },
    el(
      "div",
      { class: "row-actions between" },
      el("strong", { class: "sm" }, "运行记录"),
      el("div", { class: "row-actions xs-gap" }, runCountEl)
    ),
    taskFilterChip,
    el(
      "div",
      { class: "search-box" },
      icon("search", 15),
      el("input", {
        type: "search",
        placeholder: "筛选运行 ID 或任务名…",
        "aria-label": "筛选运行记录",
        onInput: (e) => {
          searchQuery = e.target.value.trim().toLowerCase();
          renderRunList();
        },
      })
    ),
    statusSel,
    listCardsEl,
    loadMoreBtn
  );

  layoutEl.append(leftPane, detailPaneEl);
  if (selectedId) layoutEl.classList.add("has-selected");

  container.replaceChildren(
    el(
      "div",
      { class: "page-body" },
      pageHead({
        eyebrow: "Activity log",
        title: "运行与日志",
        subtitle: "主从双栏视图 · 虚拟化日志滚动 · SSE 实时推送",
        actions: [
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                try {
                  await fetchRuns(false, true);
                  renderRunList();
                  if (selectedId) loadRunDetail(selectedId);
                } catch (err) {
                  toast(`刷新记录失败：${err.message}`, "danger");
                }
              },
            },
            icon("refresh", 14),
            "刷新记录"
          ),
        ],
      }),
      layoutEl
    )
  );

  renderRunList();
  loadRunDetail(selectedId);

  const onListChange = async () => {
    if (destroyed) return;
    await fetchRuns(false, true).catch(() => {});
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
