import { api } from "../api.js";
import {
  el,
  toast,
  confirmModal,
  statusBadge,
  fmtTimeShort,
  fmtDuration,
  relTime,
  debounce,
  SITE_LABELS,
} from "../util.js";
import { navigate } from "../router.js";
import { createDownloadOptions } from "../components/download-options.js";

export async function renderTaskDetail(container, route, ctx) {
  const taskId = route.id;

  const [detailRes, tasksRes, runsRes, inputsRes, overviewRes] = await Promise.all([
    api.get(`/api/tasks/${encodeURIComponent(taskId)}`).catch(() => null),
    api.get("/api/tasks").catch(() => null),
    api.get(`/api/runs?task_id=${encodeURIComponent(taskId)}&limit=12`).catch(() => null),
    api.get("/api/inputs").catch(() => null),
    api.get("/api/config/overview").catch(() => null),
  ]);

  const list = Array.isArray(tasksRes?.tasks) ? tasksRes.tasks : [];
  const task = detailRes?.task || list.find((t) => String(t.id) === String(taskId));

  if (!task) {
    container.replaceChildren(
      el(
        "div",
        { class: "fl-card stack", style: { textAlign: "center", padding: "2rem" } },
        el("strong", null, `未找到定时任务 #${taskId}`),
        el("a", { class: "fl-btn sm", href: "#tasks", style: { alignSelf: "center" } }, "返回定时任务列表")
      )
    );
    return;
  }

  const inputs = Array.isArray(inputsRes?.files) ? inputsRes.files : [];
  const taskRuns = Array.isArray(detailRes?.recent_runs)
    ? detailRes.recent_runs
    : Array.isArray(runsRes?.runs)
      ? runsRes.runs
      : [];
  const health = detailRes?.health || {};
  const matchedSites = Array.isArray(detailRes?.sites)
    ? detailRes.sites
    : Array.isArray(task.sites)
      ? task.sites
      : [];

  const nextAt = Array.isArray(task.next_runs) && task.next_runs.length ? task.next_runs[0] : null;
  const nameIn = el("input", { type: "text", required: true, value: task.name || "" });
  const cronIn = el("input", { type: "text", required: true, value: task.cron_expr || "" });
  const cronHint = el(
    "div",
    { class: "muted xs" },
    `${task.cron_desc || ""}${nextAt ? ` · 下次执行: ${relTime(nextAt)}` : ""}`
  );
  const enabledIn = el("input", { type: "checkbox", role: "switch", switch: true, checked: Boolean(task.enabled) });
  const urlsIn = el("textarea", {
    rows: 4,
    value: Array.isArray(task.urls) ? task.urls.join("\n") : task.urls || "",
    placeholder: "每行一个 URL",
  });
  const inputSel = el(
    "select",
    null,
    el("option", { value: "" }, "不使用 NAS 链接文件"),
    ...inputs.map((f) => {
      const fn = typeof f === "string" ? f : f.name || f.filename;
      return fn
        ? el("option", { value: fn, selected: fn === task.input_file }, `${fn}${f.url_count ? ` (${f.url_count} 条)` : ""}`)
        : null;
    })
  );
  const notesIn = el("input", { type: "text", value: task.notes || "", placeholder: "备注信息（可选）" });

  const optCtrl = createDownloadOptions({
    initial: {
      proxy_mode: task.proxy_mode,
      proxy_url: task.proxy_url,
      subdir: task.subdir,
      skip_mode: task.skip_mode,
      filename_format: task.filename_format,
      extra_args: task.extra_args,
      use_archive: task.use_archive,
      archive_backfill: task.archive_backfill,
      postprocess_mode: task.postprocess_mode,
      postprocess_date_field: task.postprocess_date_field,
      postprocess_command: task.postprocess_command,
    },
    overview: overviewRes,
    taskId: task.id,
    getContextUrls: () => urlsIn.value,
    getInputFile: () => inputSel.value,
  });

  const refreshCron = debounce(async () => {
    const expr = cronIn.value.trim();
    if (!expr) return;
    try {
      const res = await api.post("/api/cron/preview", { cron_expr: expr });
      const nextRuns = res?.next_runs || [];
      cronHint.textContent = nextRuns.length
        ? `${res.description || ""} · 未来触发：${nextRuns.slice(0, 3).join(" / ")}`
        : res?.description || "表达式有效";
    } catch (err) {
      cronHint.textContent = `表达式无效：${err.message}`;
    }
  }, 250);
  cronIn.addEventListener("input", refreshCron);
  urlsIn.addEventListener("input", () => optCtrl.refreshPreview());
  inputSel.addEventListener("change", () => optCtrl.refreshPreview());

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, "保存修改");

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
        if (!nameIn.value.trim() || !cronIn.value.trim() || (!urls.length && !inputSel.value)) {
          toast("请确保名称、Cron 表达式以及至少一个 URL 或 NAS 文件不为空", "danger");
          return;
        }
        saveBtn.disabled = true;
        try {
          await api.put(`/api/tasks/${encodeURIComponent(taskId)}`, {
            name: nameIn.value.trim(),
            cron_expr: cronIn.value.trim(),
            enabled: enabledIn.checked,
            urls,
            input_file: inputSel.value || "",
            notes: notesIn.value.trim(),
            ...optCtrl.getPayload(),
          });
          toast("任务配置已保存");
          await ctx?.refreshHeader?.();
        } catch (err) {
          toast(`保存失败：${err.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "任务名称"), nameIn),
      el("div", { class: "field" }, el("label", null, "Cron 表达式"), cronIn, cronHint)
    ),
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "目标 URL（每行一个）"), urlsIn),
      el(
        "div",
        { class: "stack sm-gap" },
        el("div", { class: "field" }, el("label", null, "NAS /data/inputs/ 文件"), inputSel),
        el("div", { class: "field" }, el("label", null, "备注"), notesIn),
        el("label", { class: "switch-inline" }, enabledIn, el("span", null, "启用此定时任务"))
      )
    ),
    el(
      "details",
      { class: "fl-expander", open: true },
      el("summary", { class: "fl-expander-head" }, "高级选项与生效配置预览"),
      el("div", { class: "fl-expander-body" }, optCtrl.el)
    ),
    el(
      "div",
      { class: "row-actions between" },
      el(
        "button",
        {
          type: "button",
          class: "fl-btn danger",
          onClick: async () => {
            const ok = await confirmModal({
              title: "删除定时任务",
              message: `确定永久删除定时任务「${task.name}」吗？（历史运行日志将保留）`,
              okText: "删除",
              danger: true,
            });
            if (!ok) return;
            await api.del(`/api/tasks/${encodeURIComponent(taskId)}`);
            toast("已删除定时任务");
            await ctx?.refreshHeader?.();
            navigate("#tasks");
          },
        },
        "删除任务"
      ),
      el(
        "div",
        { class: "row-actions" },
        el(
          "button",
          {
            type: "button",
            class: "fl-btn",
            onClick: async () => {
              const res = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/run`, { simulate: true });
              toast(res?.run_id ? `已启动模拟试跑 #${res.run_id}` : "已加入模拟队列");
              if (res?.run_id) navigate(`#runs/${res.run_id}`);
            },
          },
          "模拟试跑 (-s)"
        ),
        el(
          "button",
          {
            type: "button",
            class: "fl-btn",
            onClick: async () => {
              const res = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/run`, { simulate: false });
              toast(res?.run_id ? `已启动运行 #${res.run_id}` : "已加入运行队列");
              if (res?.run_id) navigate(`#runs/${res.run_id}`);
            },
          },
          "立即运行"
        ),
        saveBtn
      )
    )
  );

  // Task health summary KPI strip (when stats exist)
  const healthRow =
    health.total > 0
      ? el(
          "div",
          { class: "stats-grid" },
          el("div", { class: "fl-stat-card" }, el("span", { class: "fl-stat-label" }, "历史运行次数"), el("strong", null, String(health.total))),
          el(
            "div",
            { class: `fl-stat-card${health.success_rate >= 0.8 ? " ok" : health.success_rate !== null ? " warn" : ""}` },
            el("span", { class: "fl-stat-label" }, "成功率"),
            el("strong", null, health.success_rate !== null && health.success_rate !== undefined ? `${Math.round(health.success_rate * 100)}%` : "—")
          ),
          el("div", { class: "fl-stat-card ok" }, el("span", { class: "fl-stat-label" }, "累计下载"), el("strong", null, String(health.total_downloaded ?? 0))),
          el("div", { class: "fl-stat-card" }, el("span", { class: "fl-stat-label" }, "平均耗时"), el("strong", null, fmtDuration(health.avg_duration_sec)))
        )
      : null;

  const historyCard = el(
    "section",
    { class: "fl-card stack sm-gap" },
    el("h2", { class: "fl-card-title", style: { margin: 0 } }, "本任务近期运行历史")
  );
  if (!taskRuns.length) {
    historyCard.appendChild(el("div", { class: "empty-state" }, "暂无运行历史记录"));
  } else {
    const tblWrap = el(
      "div",
      { class: "table-wrapper", tabindex: "0", "aria-label": "任务运行历史表格" },
      el(
        "table",
        { class: "data-table" },
        el(
          "thead",
          null,
          el("tr", null, el("th", null, "ID"), el("th", null, "状态"), el("th", null, "新增 / 跳过"), el("th", null, "耗时"), el("th", null, "触发时间"), el("th", null, "操作"))
        ),
        el(
          "tbody",
          null,
          ...taskRuns.map((r) =>
            el(
              "tr",
              null,
              el("td", null, el("a", { href: `#runs/${r.id}` }, `#${r.id}`)),
              el("td", null, statusBadge(r.status)),
              el("td", null, `+${r.downloaded_count ?? 0} / ${r.skipped_count ?? 0}`),
              el("td", null, fmtDuration(r.duration_sec)),
              el("td", null, fmtTimeShort(r.created_at)),
              el("td", null, el("a", { class: "fl-btn subtle xs", href: `#runs/${r.id}` }, "日志"))
            )
          )
        )
      )
    );
    historyCard.appendChild(tblWrap);
  }

  container.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          { class: "row-actions" },
          el("a", { class: "fl-btn subtle sm", href: "#tasks" }, "← 返回任务列表"),
          el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.3rem" } }, task.name || `任务 #${task.id}`),
          ...matchedSites.map((s) => el("a", { class: "fl-badge info", href: `#site/${encodeURIComponent(s)}` }, SITE_LABELS[s] || s))
        ),
        el("span", { class: "muted xs" }, `Task ID #${task.id}`)
      ),
      healthRow,
      form,
      historyCard
    )
  );
}
