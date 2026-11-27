import { api } from "../api.js";
import { events } from "../events.js";
import {
  el,
  toast,
  confirmModal,
  statusBadge,
  fmtTimeShort,
  relTime,
  debounce,
  SITE_LABELS,
} from "../util.js";
import { navigate } from "../router.js";
import { createDownloadOptions } from "../components/download-options.js";
import { pageHead, cardHead, emptyState, field } from "../ui.js";
import { icon } from "../icons.js";

export async function renderTasks(container, _route, ctx) {
  let destroyed = false;
  let tasks = [];
  let inputs = [];
  let overview = null;
  const selectedIds = new Set();
  let query = "";
  let filterEnabled = "all";
  let showCreateForm = false;

  const page = el("div", { class: "page-body" });
  const listWrap = el("div", { class: "task-list" });
  const createSlot = el("div");
  const batchBar = el("div", { class: "fl-infobar hidden" });
  const countEl = el("span", { class: "muted xs", style: { marginInlineStart: "auto", whiteSpace: "nowrap" } });

  const listCard = el(
    "section",
    { class: "fl-card list-card" },
    el(
      "div",
      { class: "card-head", style: { padding: "14px 18px 12px" } },
      el(
        "div",
        { class: "card-head-text" },
        el("span", { class: "card-head-icon" }, icon("calendar", 16)),
        el(
          "div",
          null,
          el("h2", { class: "fl-card-title" }, "全部定时任务"),
          el("div", { class: "card-head-sub" }, "批量启停、立即运行或进入详情调整高级配置")
        )
      ),
      el("div", { class: "row-actions" }, countEl)
    ),
    listWrap
  );

  async function fetchData() {
    const [tasksRes, inputsRes, overviewRes] = await Promise.all([
      api.get("/api/tasks"),
      api.get("/api/inputs").catch(() => null),
      api.get("/api/config/overview").catch(() => null),
    ]);
    if (destroyed) return;
    tasks = Array.isArray(tasksRes?.tasks) ? tasksRes.tasks : [];
    inputs = Array.isArray(inputsRes?.files) ? inputsRes.files : [];
    overview = overviewRes;
  }

  function renderBatchBar() {
    batchBar.replaceChildren();
    if (!selectedIds.size) {
      batchBar.classList.add("hidden");
      return;
    }
    batchBar.classList.remove("hidden");
    batchBar.className = "fl-infobar info";
    const runBatch = async (action, label) => {
      if (action === "delete") {
        const ok = await confirmModal({
          title: "批量删除任务",
          message: `确定永久删除选中的 ${selectedIds.size} 个定时任务吗？`,
          okText: "删除",
          danger: true,
        });
        if (!ok) return;
      }
      try {
        await api.post("/api/tasks/batch", {
          action,
          task_ids: [...selectedIds],
        });
        toast(`已对 ${selectedIds.size} 个任务执行：${label}`);
        selectedIds.clear();
        await fetchData();
        await ctx?.refreshHeader?.();
        renderList();
        renderBatchBar();
      } catch (err) {
        toast(`批量操作失败：${err.message}`, "danger");
      }
    };

    batchBar.append(
      el("span", { class: "infobar-icon" }, icon("check-circle", 16)),
      el("div", { class: "infobar-body" }, el("strong", null, `已选择 ${selectedIds.size} 个任务`)),
      el(
        "div",
        { class: "infobar-actions" },
        el("button", { type: "button", class: "fl-btn sm", onClick: () => runBatch("enable", "批量启用") }, "启用选中"),
        el("button", { type: "button", class: "fl-btn sm", onClick: () => runBatch("disable", "批量暂停") }, "暂停选中"),
        el("button", { type: "button", class: "fl-btn danger sm", onClick: () => runBatch("delete", "批量删除") }, icon("trash", 14), "删除选中"),
        el(
          "button",
          {
            type: "button",
            class: "fl-btn subtle sm",
            onClick: () => {
              selectedIds.clear();
              renderList();
              renderBatchBar();
            },
          },
          "取消选择"
        )
      )
    );
  }

  function renderCreateCard() {
    createSlot.innerHTML = "";
    if (!showCreateForm) return;

    const nameIn = el("input", { type: "text", required: true, placeholder: "例如 Twitter 每日点赞增量" });
    const cronIn = el("input", { type: "text", required: true, value: "0 */6 * * *", placeholder: "0 */6 * * *" });
    const cronPreview = el("div", { class: "hint" }, "正在计算未来执行时间…");
    const enabledIn = el("input", { type: "checkbox", role: "switch", switch: true, checked: true });
    const urlsIn = el("textarea", { rows: 4, placeholder: "每行一个目标 URL，例如 https://x.com/..." });
    const inputSel = el(
      "select",
      null,
      el("option", { value: "" }, "不使用 NAS 链接文件"),
      ...inputs.map((f) => {
        const fn = typeof f === "string" ? f : f.name || f.filename;
        return fn ? el("option", { value: fn }, `${fn}${f.url_count ? ` (${f.url_count} 条)` : ""}`) : null;
      })
    );
    const notesIn = el("input", { type: "text", placeholder: "备注信息（可选）" });

    const optCtrl = createDownloadOptions({
      overview,
      getContextUrls: () => urlsIn.value,
      getInputFile: () => inputSel.value,
    });

    const updateCronPreview = debounce(async () => {
      const expr = cronIn.value.trim();
      if (!expr) {
        cronPreview.textContent = "请输入 Cron 表达式（5 段：分 时 日 月 周）";
        return;
      }
      try {
        const res = await api.post("/api/cron/preview", { cron_expr: expr });
        const nextList = res?.next_runs || [];
        cronPreview.textContent = nextList.length
          ? `${res.description || ""} · 未来触发：${nextList.slice(0, 3).join(" / ")}`
          : res?.description || "Cron 表达式有效";
      } catch (err) {
        cronPreview.textContent = `表达式无效：${err.message}`;
      }
    }, 250);

    cronIn.addEventListener("input", updateCronPreview);
    urlsIn.addEventListener("input", () => optCtrl.refreshPreview());
    inputSel.addEventListener("change", () => optCtrl.refreshPreview());
    updateCronPreview();

    const cronPresets = el(
      "div",
      { class: "row-actions xs-gap", style: { marginTop: "2px" } },
      ...[
        { label: "每小时", expr: "0 * * * *" },
        { label: "每 6 小时", expr: "0 */6 * * *" },
        { label: "每天 03:00", expr: "0 3 * * *" },
        { label: "每周日 04:00", expr: "0 4 * * 0" },
      ].map((p) =>
        el(
          "button",
          {
            type: "button",
            class: "fl-btn subtle xs",
            onClick: () => {
              cronIn.value = p.expr;
              updateCronPreview();
            },
          },
          p.label
        )
      )
    );

    const submitBtn = el("button", { type: "submit", class: "fl-btn accent" }, icon("check", 15), "保存并创建任务");

    const form = el(
      "form",
      {
        class: "fl-card stack",
        onSubmit: async (e) => {
          e.preventDefault();
          const urls = urlsIn.value
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
          const name = nameIn.value.trim();
          const cron = cronIn.value.trim();
          if (!name || !cron || (!urls.length && !inputSel.value)) {
            toast("请填写任务名称、Cron 表达式，并至少提供一个 URL 或 NAS 输入文件", "danger");
            return;
          }
          submitBtn.disabled = true;
          try {
            await api.post("/api/tasks", {
              name,
              cron_expr: cron,
              enabled: enabledIn.checked,
              urls,
              input_file: inputSel.value || "",
              notes: notesIn.value.trim(),
              ...optCtrl.getPayload(),
            });
            toast(`已创建定时任务「${name}」`);
            showCreateForm = false;
            renderCreateCard();
            await fetchData();
            await ctx?.refreshHeader?.();
            renderList();
          } catch (err) {
            toast(`创建失败：${err.message}`, "danger");
          } finally {
            submitBtn.disabled = false;
          }
        },
      },
      cardHead("新建定时任务", {
        iconName: "plus",
        subtitle: "设置 Cron 调度与目标链接，创建后可随时调整",
        actions: [
          el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle sm",
              onClick: () => {
                showCreateForm = false;
                renderCreateCard();
              },
            },
            icon("chevron-down", 14),
            "收起"
          ),
        ],
      }),
      el(
        "div",
        { class: "form-grid-2" },
        field("任务名称", nameIn, { hint: "用于在列表、日志和通知中识别该任务" }),
        field("Cron 调度表达式", cronIn, { extra: el("div", { class: "stack xs-gap" }, cronPresets, cronPreview) })
      ),
      el(
        "div",
        { class: "form-grid-2" },
        field("目标 URL", urlsIn, { hint: "每行一个链接，空行与 # 开头的行会被忽略" }),
        el(
          "div",
          { class: "stack sm-gap" },
          field("或绑定 NAS /data/inputs/ 文件", inputSel),
          field("备注", notesIn),
          el("label", { class: "switch-inline" }, enabledIn, el("span", null, "创建后立即启用自动调度"))
        )
      ),
      el(
        "details",
        { class: "fl-expander", open: true },
        el("summary", { class: "fl-expander-head" }, "高级下载与去重 / 后处理配置"),
        el("div", { class: "fl-expander-body" }, optCtrl.el)
      ),
      el(
        "div",
        { class: "row-actions", style: { justifyContent: "flex-end" } },
        el(
          "button",
          {
            type: "button",
            class: "fl-btn",
            onClick: () => {
              showCreateForm = false;
              renderCreateCard();
            },
          },
          "取消"
        ),
        submitBtn
      )
    );

    createSlot.appendChild(form);
  }

  function renderList() {
    listWrap.innerHTML = "";
    const filtered = tasks.filter((t) => {
      if (filterEnabled === "enabled" && !t.enabled) return false;
      if (filterEnabled === "disabled" && t.enabled) return false;
      if (query) {
        const hay = `${t.name || ""} ${(t.urls || []).join(" ")} ${t.input_file || ""} ${t.cron_expr || ""}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    countEl.textContent = `${filtered.length} / ${tasks.length} 个任务`;

    if (!filtered.length) {
      listWrap.appendChild(
        el(
          "div",
          { style: { padding: "0 18px 18px" } },
          emptyState(
            tasks.length ? "调整筛选条件或搜索关键字后重试" : "还没有配置任何定时任务，点击右上角「新建定时任务」开始。",
            "calendar",
            tasks.length ? "没有匹配的任务" : "尚无定时任务"
          )
        )
      );
      return;
    }

    listWrap.appendChild(
      el(
        "div",
        { class: "task-list-head" },
        el("span", null, ""),
        el("span", null, "任务与目标"),
        el("span", null, "调度计划"),
        el("span", null, "状态"),
        el("span", { style: { textAlign: "end" } }, "操作")
      )
    );

    for (const t of filtered) {
      const checked = selectedIds.has(t.id);
      const hasUrls = Array.isArray(t.urls) && t.urls.length > 0;
      const urlPart = hasUrls ? `${t.urls[0]}${t.urls.length > 1 ? ` (+${t.urls.length - 1})` : ""}` : "";
      const urlSummary =
        t.input_file && hasUrls
          ? `输入列表: ${t.input_file} + ${urlPart}`
          : t.input_file
            ? `输入列表: ${t.input_file}`
            : hasUrls
              ? urlPart
              : "未配置目标";

      const recentStatuses = Array.isArray(t.recent_statuses) ? t.recent_statuses : [];
      const nextAt = Array.isArray(t.next_runs) && t.next_runs.length ? t.next_runs[0] : null;
      const sitesList = Array.isArray(t.sites) ? t.sites : [];

      const row = el(
        "div",
        { class: `task-row${checked ? " selected" : ""}` },
        el(
          "div",
          { class: "task-lead" },
          el("input", {
            type: "checkbox",
            class: "checkbox-custom",
            checked,
            "aria-label": `选择 ${t.name}`,
            onChange: (e) => {
              if (e.target.checked) selectedIds.add(t.id);
              else selectedIds.delete(t.id);
              row.classList.toggle("selected", e.target.checked);
              renderBatchBar();
            },
          }),
          el("input", {
            type: "checkbox",
            role: "switch",
            switch: true,
            checked: Boolean(t.enabled),
            title: t.enabled ? "已启用：点击暂停" : "已暂停：点击启用",
            "aria-label": `启用或暂停 ${t.name}`,
            onChange: async (e) => {
              const next = e.target.checked;
              try {
                const res = await api.post(`/api/tasks/${t.id}/toggle`, {});
                if (res?.task) {
                  Object.assign(t, res.task);
                } else {
                  t.enabled = next;
                }
                toast(t.enabled ? `已启用「${t.name}」` : `已暂停「${t.name}」`);
                renderList();
                await ctx?.refreshHeader?.();
              } catch (err) {
                e.target.checked = !next;
                toast(`切换失败：${err.message}`, "danger");
              }
            },
          })
        ),
        el(
          "div",
          { class: "task-main" },
          el(
            "div",
            { class: "task-title-row" },
            el("a", { href: `#task/${t.id}`, class: "task-name", title: t.name || `任务 #${t.id}` }, t.name || `任务 #${t.id}`),
            ...sitesList.slice(0, 3).map((s) => el("span", { class: "fl-badge" }, SITE_LABELS[s] || s))
          ),
          el("div", { class: "task-url", title: urlSummary }, urlSummary)
        ),
        el(
          "div",
          { class: "task-sched" },
          el("code", null, t.cron_expr || "—"),
          el("span", { class: "xs muted", title: t.cron_desc || "" }, t.cron_desc || "自定义调度"),
          el(
            "span",
            { class: "xs muted" },
            t.enabled && nextAt ? `下次：${relTime(nextAt)}` : t.enabled ? "已排程" : "已暂停"
          )
        ),
        el(
          "div",
          { class: "task-state" },
          recentStatuses.length
            ? el(
                "span",
                { class: "health-bars", title: "最近运行历史（点击查看对应日志）" },
                ...recentStatuses.map((rs) =>
                  el("a", {
                    href: `#runs/${rs.id}`,
                    class: `health-bar ${rs.status}`,
                    title: `#${rs.id} ${rs.status} (+${rs.downloaded_count ?? 0})`,
                    "aria-label": `查看 Run #${rs.id}`,
                  })
                )
              )
            : null,
          t.last_status ? statusBadge(t.last_status) : el("span", { class: "status-pill neutral" }, "尚未运行")
        ),
        el(
          "div",
          { class: "task-actions" },
          el(
            "button",
            {
              type: "button",
              class: "fl-icon-btn",
              title: "立即运行",
              "aria-label": `立即运行 ${t.name}`,
              onClick: async () => {
                try {
                  const res = await api.post(`/api/tasks/${t.id}/run`, { simulate: false });
                  if (res?.already_active) {
                    toast(`任务已在运行或排队中 (Run #${res.run_id})`);
                  } else {
                    toast(res?.run_id ? `已启动 Run #${res.run_id}` : "已加入队列");
                  }
                } catch (err) {
                  toast(`触发失败：${err.message}`, "danger");
                }
              },
            },
            icon("play", 15)
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-icon-btn",
              title: "模拟试跑 (-s)",
              "aria-label": `模拟试跑 ${t.name}`,
              onClick: async () => {
                try {
                  const res = await api.post(`/api/tasks/${t.id}/run`, { simulate: true });
                  if (res?.already_active) {
                    toast(`任务已在运行或排队中 (Run #${res.run_id})`);
                  } else {
                    toast(res?.run_id ? `已启动模拟试跑 #${res.run_id}` : "已加入模拟队列");
                  }
                } catch (err) {
                  toast(`模拟试跑失败：${err.message}`, "danger");
                }
              },
            },
            icon("zap", 15)
          ),
          el(
            "a",
            { class: "fl-icon-btn", href: `#task/${t.id}`, title: "编辑配置", "aria-label": `编辑 ${t.name}` },
            icon("edit", 15)
          )
        )
      );

      listWrap.appendChild(row);
    }
  }

  await fetchData();
  if (destroyed) return;

  const filterButtons = [
    { value: "all", label: "全部" },
    { value: "enabled", label: "已启用" },
    { value: "disabled", label: "已暂停" },
  ].map((item) =>
    el(
      "button",
      {
        type: "button",
        class: "fl-seg-btn",
        "data-filter": item.value,
        "aria-pressed": String(filterEnabled === item.value),
        onClick: () => {
          filterEnabled = item.value;
          filterButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filterEnabled)));
          renderList();
        },
      },
      item.label
    )
  );

  page.append(
    pageHead({
      eyebrow: "Scheduler",
      title: "定时任务",
      subtitle: "基于 Cron 自动调度下载，支持批量启停、模拟试跑与精细配置覆盖",
      actions: [
        el(
          "button",
          {
            type: "button",
            class: "fl-btn accent sm",
            onClick: () => {
              showCreateForm = !showCreateForm;
              renderCreateCard();
            },
          },
          icon("plus", 14),
          "新建定时任务"
        ),
      ],
    }),
    el(
      "div",
      { class: "fl-card row-actions", style: { padding: "10px 12px" } },
      el(
        "div",
        { class: "search-box" },
        icon("search", 15),
        el("input", {
          type: "search",
          placeholder: "搜索任务名、URL 或 Cron 表达式…",
          "aria-label": "搜索任务",
          onInput: (e) => {
            query = e.target.value.trim().toLowerCase();
            renderList();
          },
        })
      ),
      el("div", { class: "fl-seg-group", role: "group", "aria-label": "按状态筛选" }, ...filterButtons)
    ),
    batchBar,
    createSlot,
    listCard
  );

  renderList();
  renderBatchBar();
  container.replaceChildren(page);

  const onEvt = async () => {
    if (destroyed) return;
    await fetchData().catch(() => {});
    renderList();
    renderBatchBar();
  };
  const unsub1 = events.on("tasks_changed", onEvt);
  const unsub2 = events.on("run_finished", onEvt);

  return () => {
    destroyed = true;
    unsub1();
    unsub2();
  };
}
