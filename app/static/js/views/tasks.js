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
} from "../util.js";
import { navigate } from "../router.js";
import { createDownloadOptions } from "../components/download-options.js";

export async function renderTasks(container, _route, ctx) {
  let destroyed = false;
  let tasks = [];
  let inputs = [];
  let overview = null;
  let selectedIds = new Set();
  let query = "";
  let filterEnabled = "all"; // "all" | "enabled" | "disabled"
  let showCreateForm = false;

  const page = el("div", { class: "stack" });
  const listWrap = el("div", { class: "stack sm-gap" });
  const createSlot = el("div");
  const batchBar = el("div", { class: "fl-infobar hidden" });

  async function fetchData() {
    const [tasksRes, inputsRes, overviewRes] = await Promise.all([
      api.get("/api/tasks"),
      api.get("/api/inputs").catch(() => null),
      api.get("/api/config/overview").catch(() => null),
    ]);
    if (destroyed) return;
    tasks = tasksRes?.tasks || tasksRes?.items || (Array.isArray(tasksRes) ? tasksRes : []);
    inputs = inputsRes?.files || inputsRes?.items || (Array.isArray(inputsRes) ? inputsRes : []);
    overview = overviewRes;
  }

  function renderBatchBar() {
    batchBar.innerHTML = "";
    if (!selectedIds.size) {
      batchBar.classList.add("hidden");
      return;
    }
    batchBar.classList.remove("hidden");
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
    };

    batchBar.append(
      el("strong", { class: "sm" }, `已选择 ${selectedIds.size} 个任务`),
      el(
        "div",
        { class: "row-actions", style: { marginInlineStart: "auto" } },
        el("button", { type: "button", class: "fl-btn sm", onClick: () => runBatch("enable", "批量启用") }, "启用选中"),
        el("button", { type: "button", class: "fl-btn sm", onClick: () => runBatch("disable", "批量暂停") }, "暂停选中"),
        el("button", { type: "button", class: "fl-btn danger sm", onClick: () => runBatch("delete", "批量删除") }, "删除选中"),
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
    const cronPreview = el("div", { class: "muted xs" }, "正在计算未来执行时间…");
    const enabledIn = el("input", { type: "checkbox", role: "switch", switch: true, checked: true });
    const urlsIn = el("textarea", { rows: 3, placeholder: "每行一个目标 URL，例如 https://x.com/..." });
    const inputSel = el(
      "select",
      null,
      el("option", { value: "" }, "不使用 NAS 链接文件"),
      ...inputs.map((f) => {
        const fn = typeof f === "string" ? f : f.filename || f.name;
        return fn ? el("option", { value: fn }, fn) : null;
      })
    );

    const optCtrl = createDownloadOptions({
      overview,
      getContextUrl: () => urlsIn.value,
    });

    const updateCronPreview = debounce(async () => {
      const expr = cronIn.value.trim();
      if (!expr) {
        cronPreview.textContent = "请输入 Cron 表达式（5 段：分 时 日 月 周）";
        return;
      }
      try {
        const res = await api.post("/api/cron/preview", { cron_expr: expr });
        const nextList = res?.next_runs || res?.times || [];
        cronPreview.textContent = nextList.length
          ? `未来执行：${nextList.slice(0, 3).map(fmtTimeShort).join(" 、")}`
          : "Cron 表达式有效";
      } catch (err) {
        cronPreview.textContent = `表达式无效：${err.message}`;
      }
    }, 250);

    cronIn.addEventListener("input", updateCronPreview);
    urlsIn.addEventListener("input", () => optCtrl.refreshPreview());
    updateCronPreview();

    const submitBtn = el("button", { type: "submit", class: "fl-btn accent" }, "保存并创建任务");

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
              input_file: inputSel.value || undefined,
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
      el(
        "div",
        { class: "row-actions between" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "新建定时任务"),
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
          "收起"
        )
      ),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "任务名称"), nameIn),
        el("div", { class: "field" }, el("label", null, "Cron 调度表达式"), cronIn, cronPreview)
      ),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "目标 URL（每行一个）"), urlsIn),
        el(
          "div",
          { class: "stack sm-gap" },
          el("div", { class: "field" }, el("label", null, "或绑定 NAS /data/inputs/ 文件"), inputSel),
          el("label", { class: "switch-inline" }, enabledIn, el("span", null, "创建后立即启用自动调度"))
        )
      ),
      el(
        "details",
        { class: "fl-expander", open: true },
        el("summary", { class: "fl-expander-head" }, "高级下载与去重/后处理配置"),
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

    if (!filtered.length) {
      listWrap.appendChild(
        el("div", { class: "fl-card empty-state" }, tasks.length ? "没有匹配的定时任务" : "还没有配置任何定时任务，点击右上角「+ 新建定时任务」开始。")
      );
      return;
    }

    for (const t of filtered) {
      const checked = selectedIds.has(t.id);
      const urlSummary = t.input_file
        ? `输入列表: ${t.input_file}`
        : Array.isArray(t.urls) && t.urls.length
          ? `${t.urls[0]}${t.urls.length > 1 ? ` (+${t.urls.length - 1})` : ""}`
          : "未配置目标";

      const row = el(
        "div",
        { class: "fl-card stack sm-gap" },
        el(
          "div",
          { class: "row-actions between" },
          el(
            "div",
            { class: "row-actions", style: { minWidth: 0, flex: 1 } },
            el("input", {
              type: "checkbox",
              checked,
              "aria-label": `选择 ${t.name}`,
              onChange: (e) => {
                if (e.target.checked) selectedIds.add(t.id);
                else selectedIds.delete(t.id);
                renderBatchBar();
              },
            }),
            el("input", {
              type: "checkbox",
              role: "switch",
              switch: true,
              checked: Boolean(t.enabled),
              title: t.enabled ? "已启用：点击暂停" : "已暂停：点击启用",
              onChange: async (e) => {
                const next = e.target.checked;
                try {
                  await api.post(`/api/tasks/${t.id}/toggle`, {});
                  t.enabled = next;
                  toast(next ? `已启用「${t.name}」` : `已暂停「${t.name}」`);
                  await ctx?.refreshHeader?.();
                } catch (err) {
                  e.target.checked = !next;
                  toast(`切换失败：${err.message}`, "danger");
                }
              },
            }),
            el(
              "div",
              { style: { minWidth: 0, flex: 1 } },
              el("a", { href: `#task/${t.id}`, style: { fontWeight: 600, fontSize: "0.95rem" } }, t.name || `任务 #${t.id}`),
              el("div", { class: "muted xs", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, urlSummary)
            )
          ),
          el(
            "div",
            { class: "row-actions" },
            t.last_run_status ? statusBadge(t.last_run_status) : el("span", { class: "fl-badge neutral" }, "尚未运行"),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn sm",
                onClick: async () => {
                  const res = await api.post(`/api/tasks/${t.id}/run`, { simulate: false });
                  toast(res?.run_id ? `已启动 Run #${res.run_id}` : "已加入队列");
                },
              },
              "立即运行"
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn subtle sm",
                onClick: () => navigate(`#task/${t.id}`),
              },
              "编辑配置"
            )
          )
        ),
        el(
          "div",
          { class: "row-actions between muted xs" },
          el("span", null, `Cron: ${t.cron_expr} · 下次执行: ${t.enabled ? relTime(t.next_run_at) : "已暂停"}`),
          el(
            "span",
            null,
            t.last_run_at ? `上次运行: ${fmtTimeShort(t.last_run_at)}` : "无历史运行记录",
            t.last_run_id ? " · " : "",
            t.last_run_id ? el("a", { href: `#runs/${t.last_run_id}` }, `Run #${t.last_run_id}`) : null
          )
        )
      );
      listWrap.appendChild(row);
    }
  }

  await fetchData();
  if (destroyed) return;

  page.append(
    el(
      "div",
      { class: "row-actions between" },
      el(
        "div",
        null,
        el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.35rem" } }, "定时任务"),
        el("div", { class: "muted xs" }, "基于 Cron 自动调度下载，支持批量启停、模拟试跑与精细配置覆盖")
      ),
      el(
        "div",
        { class: "row-actions" },
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
          "+ 新建定时任务"
        )
      )
    ),
    el(
      "div",
      { class: "fl-card row-actions" },
      el("input", {
        type: "search",
        style: { flex: 1, minInlineSize: "180px" },
        placeholder: "搜索任务名、URL 或 Cron 表达式…",
        onInput: (e) => {
          query = e.target.value.trim().toLowerCase();
          renderList();
        },
      }),
      el(
        "select",
        {
          "aria-label": "按状态筛选",
          onChange: (e) => {
            filterEnabled = e.target.value;
            renderList();
          },
        },
        el("option", { value: "all" }, "全部状态"),
        el("option", { value: "enabled" }, "仅已启用"),
        el("option", { value: "disabled" }, "仅已暂停")
      )
    ),
    batchBar,
    createSlot,
    listWrap
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
