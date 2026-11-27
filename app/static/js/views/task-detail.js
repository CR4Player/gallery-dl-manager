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
import { pageHead, cardHead, breadcrumb, emptyState, field } from "../ui.js";
import { icon } from "../icons.js";

const CRON_PRESETS = [
  { label: "每小时", expr: "0 * * * *" },
  { label: "每 6 小时", expr: "0 */6 * * *" },
  { label: "每天 03:00", expr: "0 3 * * *" },
  { label: "每周日 04:00", expr: "0 4 * * 0" },
];

function getLocalTzLabel() {
  const offsetMin = -new Date().getTimezoneOffset();
  if (offsetMin === 0) return "UTC";
  const sign = offsetMin > 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, "0")}` : `UTC${sign}${h}`;
}

function fmtRunSlot(raw) {
  if (!raw) return "—";
  const str = String(raw).trim();
  const isoMatch = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(str);
  if (isoMatch) return `${isoMatch[1]} ${isoMatch[2]}`;
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return str;
}

export async function renderTaskDetail(container, route, ctx) {
  let destroyed = false;
  const taskId = route.id;

  const [detailRes, inputsRes, overviewRes] = await Promise.all([
    api.get(`/api/tasks/${encodeURIComponent(taskId)}`).catch((err) => {
      if (err?.status === 404) return null;
      throw err;
    }),
    api.get("/api/inputs").catch(() => null),
    api.get("/api/config/overview").catch(() => null),
  ]);
  if (destroyed) return;

  const task = detailRes?.task;

  if (!task) {
    container.replaceChildren(
      el(
        "div",
        { class: "page-body" },
        breadcrumb([{ label: "定时任务", href: "#tasks" }, { label: `#${taskId}` }]),
        el(
          "div",
          { class: "fl-card" },
          emptyState(`未找到定时任务 #${taskId}，它可能已被删除。`, "calendar", "任务不存在"),
          el("a", { class: "fl-btn sm", href: "#tasks", style: { alignSelf: "center" } }, icon("arrow-left", 14), el("span", null, "返回定时任务列表"))
        )
      )
    );
    return () => {
      destroyed = true;
    };
  }

  const inputs = Array.isArray(inputsRes?.files) ? inputsRes.files : [];
  const taskRuns = Array.isArray(detailRes?.recent_runs) ? detailRes.recent_runs : [];
  const health = detailRes?.health || {};
  const matchedSites = Array.isArray(detailRes?.sites)
    ? detailRes.sites
    : Array.isArray(task.sites)
      ? task.sites
      : [];

  let currentName = task.name || "";
  let currentNotes = task.notes || "";
  let currentCron = task.cron_expr || "";
  let currentCronDesc = task.cron_desc || currentCron;
  let currentEnabled = Boolean(task.enabled);
  let currentNextRuns = Array.isArray(task.next_runs) ? task.next_runs.slice(0, 3) : [];
  let previewNextAt = currentNextRuns[0] || null;
  let toggling = false;

  const titleTextNode = el("span", null, currentName || `任务 #${task.id}`);
  const subtitleTextNode = el("span", null);
  const dirtyBadge = el("span", { class: "fl-badge warn hidden" }, "未保存");

  const syncDirty = () => {
    const dirty =
      currentName !== (task.name || "") ||
      currentNotes !== (task.notes || "") ||
      currentCron !== (task.cron_expr || "");
    dirtyBadge.classList.toggle("hidden", !dirty);
  };

  const syncHeaderSubtitle = () => {
    const nextHint = currentEnabled
      ? previewNextAt
        ? ` · 下次执行 ${relTime(previewNextAt)}`
        : " · 已排程"
      : " · 自动调度已暂停";
    subtitleTextNode.textContent = `Task #${task.id} · ${currentCronDesc || currentCron}${nextHint}`;
  };

  // --- Inline Name Editor ---
  const nameText = el("span", { class: "inline-edit-text font-medium" }, currentName || "未命名任务");
  const nameTrigger = el(
    "button",
    {
      type: "button",
      class: "inline-edit-trigger",
      title: "点击修改任务名称（失焦或按 Enter 确认）",
    },
    nameText,
    icon("edit", 12, "inline-edit-ico")
  );
  const nameIn = el("input", {
    type: "text",
    class: "inline-edit-input",
    value: currentName,
    placeholder: "任务名称",
  });
  nameIn.classList.add("hidden");

  let cancelingName = false;
  const openNameEdit = () => {
    nameIn.value = currentName;
    nameTrigger.classList.add("hidden");
    nameIn.classList.remove("hidden");
    nameIn.focus();
    nameIn.select();
  };
  const closeNameEdit = (commit) => {
    if (nameIn.classList.contains("hidden")) return;
    if (commit) {
      const next = nameIn.value.trim();
      if (!next) {
        toast("任务名称不能为空", "danger");
        nameIn.value = currentName;
      } else {
        currentName = next;
        nameText.textContent = next;
        titleTextNode.textContent = next;
        syncDirty();
      }
    }
    nameIn.classList.add("hidden");
    nameTrigger.classList.remove("hidden");
  };
  nameTrigger.addEventListener("click", openNameEdit);
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeNameEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelingName = true;
      closeNameEdit(false);
      cancelingName = false;
    }
  });
  nameIn.addEventListener("blur", () => {
    if (!cancelingName) closeNameEdit(true);
  });

  // --- Inline Notes Editor ---
  const notesText = el(
    "span",
    { class: `inline-edit-text${currentNotes ? "" : " muted"}` },
    currentNotes || "未填写（点击添加）"
  );
  const notesTrigger = el(
    "button",
    {
      type: "button",
      class: "inline-edit-trigger",
      title: "点击修改备注（失焦或按 Enter 确认）",
    },
    notesText,
    icon("edit", 12, "inline-edit-ico")
  );
  const notesIn = el("input", {
    type: "text",
    class: "inline-edit-input",
    value: currentNotes,
    placeholder: "备注信息（仅面板展示）",
  });
  notesIn.classList.add("hidden");

  let cancelingNotes = false;
  const openNotesEdit = () => {
    notesIn.value = currentNotes;
    notesTrigger.classList.add("hidden");
    notesIn.classList.remove("hidden");
    notesIn.focus();
    notesIn.select();
  };
  const closeNotesEdit = (commit) => {
    if (notesIn.classList.contains("hidden")) return;
    if (commit) {
      currentNotes = notesIn.value.trim();
      notesText.textContent = currentNotes || "未填写（点击添加）";
      notesText.classList.toggle("muted", !currentNotes);
      syncDirty();
    }
    notesIn.classList.add("hidden");
    notesTrigger.classList.remove("hidden");
  };
  notesTrigger.addEventListener("click", openNotesEdit);
  notesIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeNotesEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelingNotes = true;
      closeNotesEdit(false);
      cancelingNotes = false;
    }
  });
  notesIn.addEventListener("blur", () => {
    if (!cancelingNotes) closeNotesEdit(true);
  });

  // --- Inline Cron Editor & Schedule Panel ---
  const cronDescNode = el("span", { class: "inline-edit-text font-medium" }, currentCronDesc || currentCron);
  const cronCodeNode = el("code", null, currentCron);
  const cronDisplayBtn = el(
    "button",
    {
      type: "button",
      class: "inline-edit-trigger cron-display-trigger",
      title: "点击编辑 Cron 表达式或选择快捷预设",
    },
    cronDescNode,
    el("span", { class: "cron-display-meta" }, cronCodeNode, icon("edit", 12, "inline-edit-ico"))
  );

  const cronIn = el("input", {
    type: "text",
    value: currentCron,
    placeholder: "5 段 Cron 表达式，如 0 */6 * * *",
  });
  const cronDoneBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn accent xs",
    },
    el("span", null, "完成")
  );
  cronDoneBtn.addEventListener("mousedown", (e) => e.preventDefault());

  const presetButtons = CRON_PRESETS.map((p) => {
    const btn = el(
      "button",
      {
        type: "button",
        class: "cron-preset-chip",
        "data-expr": p.expr,
        "data-active": p.expr === currentCron ? "1" : "0",
      },
      p.label
    );
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", async () => {
      cronIn.value = p.expr;
      await applyCronPreview(p.expr);
      cronIn.focus();
    });
    return btn;
  });

  const cronErrNode = el("div", { class: "cron-err-msg hidden" });
  const cronEditor = el(
    "div",
    { class: "cron-inline-editor hidden", tabindex: "-1" },
    el("div", { class: "cron-editor-row" }, cronIn, cronDoneBtn),
    el("div", { class: "cron-preset-bar" }, ...presetButtons),
    cronErrNode
  );

  const nextRelNode = el("span", { class: "cron-next-rel" });
  const nextListNode = el("ol", { class: "cron-next-list" });

  const syncPresetActive = (expr) => {
    const trimmed = String(expr || "").trim();
    presetButtons.forEach((b) => {
      b.dataset.active = b.dataset.expr === trimmed ? "1" : "0";
    });
  };

  const renderScheduleView = () => {
    cronDescNode.textContent = currentCronDesc || currentCron;
    cronCodeNode.textContent = currentCron;
    syncPresetActive(cronEditor.classList.contains("hidden") ? currentCron : cronIn.value);

    nextRelNode.className = `cron-next-rel${currentEnabled ? "" : " paused"}`;
    nextRelNode.textContent = currentEnabled
      ? previewNextAt
        ? `下次：${relTime(previewNextAt)}`
        : "已排程"
      : "调度已暂停";

    if (currentNextRuns.length) {
      nextListNode.replaceChildren(
        ...currentNextRuns.slice(0, 3).map((slot, idx) =>
          el(
            "li",
            { class: "cron-next-item" },
            el(
              "span",
              { class: "cron-next-idx" },
              el("span", { class: "cron-next-dot" }, String(idx + 1)),
              `第 ${idx + 1} 次`
            ),
            el("span", null, fmtRunSlot(slot))
          )
        )
      );
    } else {
      nextListNode.replaceChildren(
        el("li", { class: "cron-next-item muted" }, el("span", null, "暂无触发计划预览"), el("span", null, "—"))
      );
    }
    syncHeaderSubtitle();
  };

  const applyCronPreview = async (expr) => {
    const trimmed = String(expr || "").trim();
    if (!trimmed) {
      cronErrNode.textContent = "Cron 表达式不能为空";
      cronErrNode.classList.remove("hidden");
      return false;
    }
    try {
      const res = await api.post("/api/cron/preview", { cron_expr: trimmed });
      if (destroyed) return false;
      currentCron = res?.normalized || trimmed;
      currentCronDesc = res?.description || currentCron;
      currentNextRuns = Array.isArray(res?.next_runs) ? res.next_runs.slice(0, 3) : [];
      if (currentNextRuns[0]) {
        const parsed = new Date(fmtRunSlot(currentNextRuns[0]).replace(" ", "T"));
        previewNextAt = !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : previewNextAt;
      }
      cronErrNode.classList.add("hidden");
      syncDirty();
      renderScheduleView();
      return true;
    } catch (err) {
      if (destroyed) return false;
      cronErrNode.textContent = `表达式无效：${err.message}`;
      cronErrNode.classList.remove("hidden");
      return false;
    }
  };

  const debouncedCronPreview = debounce(() => {
    applyCronPreview(cronIn.value);
  }, 220);

  let cancelingCron = false;
  const openCronEdit = () => {
    cronIn.value = currentCron;
    cronErrNode.classList.add("hidden");
    syncPresetActive(currentCron);
    cronDisplayBtn.classList.add("hidden");
    cronEditor.classList.remove("hidden");
    cronIn.focus();
    cronIn.select();
  };
  const closeCronEdit = async (commit) => {
    if (cronEditor.classList.contains("hidden")) return;
    if (commit) {
      const val = cronIn.value.trim();
      if (val !== currentCron || !cronErrNode.classList.contains("hidden")) {
        const ok = await applyCronPreview(val);
        if (!ok) {
          cronIn.focus();
          return;
        }
      }
    } else {
      cronIn.value = currentCron;
      cronErrNode.classList.add("hidden");
    }
    cronEditor.classList.add("hidden");
    cronDisplayBtn.classList.remove("hidden");
    syncPresetActive(currentCron);
  };

  cronDisplayBtn.addEventListener("click", openCronEdit);
  cronIn.addEventListener("input", () => {
    syncPresetActive(cronIn.value);
    cronErrNode.classList.add("hidden");
    debouncedCronPreview();
  });
  cronIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeCronEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelingCron = true;
      closeCronEdit(false);
      cancelingCron = false;
    }
  });
  cronDoneBtn.addEventListener("click", () => closeCronEdit(true));
  cronEditor.addEventListener("focusout", (e) => {
    if (cancelingCron) return;
    if (e.relatedTarget && cronEditor.contains(e.relatedTarget)) return;
    setTimeout(() => {
      if (!destroyed && !cancelingCron && !cronEditor.contains(document.activeElement)) {
        closeCronEdit(true);
      }
    }, 0);
  });

  renderScheduleView();
  if (!currentNextRuns.length && currentCron) {
    applyCronPreview(currentCron);
  }

  // --- Top-Right Immediate Enable/Disable Switch Pill ---
  const enablePillLabel = el("span", { class: "task-enable-pill-label" }, currentEnabled ? "已启用" : "已暂停");
  const enablePill = el(
    "button",
    {
      type: "button",
      role: "switch",
      class: "task-enable-pill",
      "aria-checked": currentEnabled ? "true" : "false",
      title: "切换自动调度启停状态（立即生效）",
      onClick: async () => {
        if (toggling) return;
        toggling = true;
        enablePill.disabled = true;
        try {
          const res = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/toggle`);
          if (destroyed) return;
          const updated = res?.task;
          currentEnabled = Boolean(updated ? updated.enabled : !currentEnabled);
          if (updated && Array.isArray(updated.next_runs) && updated.next_runs.length) {
            currentNextRuns = updated.next_runs.slice(0, 3);
            previewNextAt = currentNextRuns[0];
          }
          enablePill.setAttribute("aria-checked", currentEnabled ? "true" : "false");
          enablePillLabel.textContent = currentEnabled ? "已启用" : "已暂停";
          renderScheduleView();
          toast(currentEnabled ? "已启用自动调度" : "已暂停自动调度");
          await ctx?.refreshHeader?.();
        } catch (err) {
          toast(`切换状态失败：${err.message}`, "danger");
        } finally {
          toggling = false;
          if (!destroyed) enablePill.disabled = false;
        }
      },
    },
    el("span", { class: "task-enable-track", "aria-hidden": "true" }, el("span", { class: "task-enable-thumb" })),
    enablePillLabel
  );

  // --- Target Inputs & Advanced Options ---
  const urlsIn = el("textarea", {
    rows: 5,
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

  urlsIn.addEventListener("input", () => optCtrl.refreshPreview());
  inputSel.addEventListener("change", () => optCtrl.refreshPreview());

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, icon("save", 15), el("span", null, "保存修改"));

  const runNow = async (simulate) => {
    try {
      const res = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/run`, { simulate });
      if (res?.already_active) {
        toast(`任务已在运行或排队中 (Run #${res.run_id})`);
      } else {
        toast(
          simulate
            ? res?.run_id
              ? `已启动模拟试跑 #${res.run_id}`
              : "已加入模拟队列"
            : res?.run_id
              ? `已启动运行 #${res.run_id}`
              : "已加入运行队列"
        );
      }
      if (res?.run_id) navigate(`#runs/${res.run_id}`);
    } catch (err) {
      toast(`触发运行失败：${err.message}`, "danger");
    }
  };

  // --- Top Cards: 基本信息与调度 + 运行与健康 (equal height) ---
  const latestRun = taskRuns[0] || null;
  const lastResultNode = latestRun
    ? el(
        "span",
        { class: "row-actions xs-gap", style: { justifyContent: "flex-end" } },
        statusBadge(latestRun.status),
        el(
          "span",
          { class: "task-result-counts" },
          `+${latestRun.downloaded_count ?? 0} / 跳过 ${latestRun.skipped_count ?? 0}`
        ),
        task.consecutive_failures > 1
          ? el("span", { class: "fl-badge err" }, `连败 ${task.consecutive_failures}`)
          : null
      )
    : task.last_status
      ? statusBadge(task.last_status)
      : el("span", { class: "muted" }, "暂无记录");

  const basicInfoCard = el(
    "section",
    { class: "fl-card task-info-card" },
    cardHead("基本信息与调度", {
      iconName: "calendar",
      subtitle: "点击名称、备注或 Cron 字段即可行内编辑",
      actions: [dirtyBadge],
    }),
    el(
      "div",
      { class: "task-info-split" },
      el(
        "div",
        { class: "task-kv-list" },
        el(
          "div",
          { class: "task-kv-row" },
          el("span", { class: "task-kv-label" }, "任务名称"),
          el("div", { class: "task-kv-value" }, nameTrigger, nameIn, el("code", null, `#${task.id}`))
        ),
        el(
          "div",
          { class: "task-kv-row" },
          el("span", { class: "task-kv-label" }, "备注"),
          el("div", { class: "task-kv-value" }, notesTrigger, notesIn)
        ),
        el(
          "div",
          { class: "task-kv-row" },
          el("span", { class: "task-kv-label" }, "上次结果"),
          el("div", { class: "task-kv-value" }, lastResultNode)
        ),
        el(
          "div",
          { class: "task-kv-row" },
          el("span", { class: "task-kv-label" }, "最近运行"),
          el(
            "div",
            { class: `task-kv-value mono${task.last_run_at ? "" : " muted"}` },
            task.last_run_at ? fmtTimeShort(task.last_run_at) : "暂无记录"
          )
        )
      ),
      el(
        "div",
        { class: "task-cron-panel" },
        cronDisplayBtn,
        cronEditor,
        el(
          "div",
          { class: "cron-next-head" },
          el("span", null, `未来 3 次触发 (${getLocalTzLabel()})`),
          nextRelNode
        ),
        nextListNode
      )
    )
  );

  const healthCard = el(
    "aside",
    { class: "fl-card task-health-card" },
    cardHead("运行与健康", { iconName: "activity", subtitle: health.total > 0 ? "基于历史运行统计" : "暂无运行数据" }),
    health.total > 0
      ? el(
          "div",
          { class: "mini-stats-grid", style: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
          el("div", { class: "mini-stat" }, el("span", { class: "muted xs" }, "运行次数"), el("strong", null, String(health.total))),
          el(
            "div",
            { class: "mini-stat" },
            el("span", { class: "muted xs" }, "成功率"),
            el(
              "strong",
              { class: health.success_rate >= 0.8 ? "text-ok" : health.success_rate !== null ? "text-warn" : "" },
              health.success_rate !== null && health.success_rate !== undefined ? `${Math.round(health.success_rate * 100)}%` : "—"
            )
          ),
          el("div", { class: "mini-stat" }, el("span", { class: "muted xs" }, "累计下载"), el("strong", null, String(health.total_downloaded ?? 0))),
          el("div", { class: "mini-stat" }, el("span", { class: "muted xs" }, "平均耗时"), el("strong", null, fmtDuration(health.avg_duration_sec)))
        )
      : emptyState("运行一次后即可查看成功率与耗时统计", "activity"),
    task.last_run_id
      ? el(
          "a",
          { class: "fl-btn sm full task-health-foot", href: `#runs/${task.last_run_id}` },
          icon("terminal", 14),
          el("span", null, `查看最近 Run #${task.last_run_id}`)
        )
      : null
  );

  const form = el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        if (!nameIn.classList.contains("hidden")) closeNameEdit(true);
        if (!notesIn.classList.contains("hidden")) closeNotesEdit(true);
        if (!cronEditor.classList.contains("hidden")) {
          const ok = await applyCronPreview(cronIn.value);
          if (!ok) {
            toast("请先修正 Cron 表达式后再保存", "danger");
            cronIn.focus();
            return;
          }
          cronEditor.classList.add("hidden");
          cronDisplayBtn.classList.remove("hidden");
        }
        const urls = urlsIn.value
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"));
        if (!currentName.trim() || !currentCron.trim() || (!urls.length && !inputSel.value)) {
          toast("请确保名称、Cron 表达式以及至少一个 URL 或 NAS 文件不为空", "danger");
          return;
        }
        saveBtn.disabled = true;
        try {
          await api.put(`/api/tasks/${encodeURIComponent(taskId)}`, {
            name: currentName.trim(),
            cron_expr: currentCron.trim(),
            enabled: currentEnabled,
            urls,
            input_file: inputSel.value || "",
            notes: currentNotes.trim(),
            ...optCtrl.getPayload(),
          });
          toast("任务配置已保存");
          await ctx?.refreshHeader?.();
          if (!destroyed) {
            await renderTaskDetail(container, route, ctx);
          }
        } catch (err) {
          toast(`保存失败：${err.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    el("div", { class: "task-hero-grid" }, basicInfoCard, healthCard),
    el(
      "section",
      { class: "fl-card stack" },
      cardHead("目标与输入", { iconName: "link", subtitle: "支持直接链接或绑定 NAS /data/inputs/ 列表文件" }),
      field("目标 URL", urlsIn, { hint: "每行一个链接，空行与 # 开头的行会被忽略" }),
      field("NAS 列表文件", inputSel, { hint: "与上方目标 URL 可同时存在，运行时将合并执行 (-i)" })
    ),
    el(
      "section",
      { class: "fl-card stack" },
      cardHead("高级下载选项", {
        iconName: "settings",
        subtitle: "代理、Skip 策略、去重、文件名与 ExifTool 后处理",
      }),
      optCtrl.el
    ),
    el(
      "div",
      { class: "action-bar" },
      el(
        "button",
        {
          type: "button",
          class: "fl-btn danger sm",
          onClick: async () => {
            const ok = await confirmModal({
              title: "删除定时任务",
              message: `确定永久删除定时任务「${currentName || task.name}」吗？（历史运行日志将保留）`,
              okText: "删除",
              danger: true,
            });
            if (!ok) return;
            try {
              await api.del(`/api/tasks/${encodeURIComponent(taskId)}`);
              toast("已删除定时任务");
              await ctx?.refreshHeader?.();
              navigate("#tasks");
            } catch (err) {
              toast(`删除失败：${err.message}`, "danger");
            }
          },
        },
        icon("trash", 14),
        el("span", null, "删除任务")
      ),
      saveBtn
    )
  );

  // --- Run History (Full Width) ---
  const historyCard = el(
    "section",
    { class: "fl-card stack" },
    cardHead("本任务近期运行历史", {
      iconName: "terminal",
      subtitle: taskRuns.length ? `显示最近 ${taskRuns.length} 次运行` : "",
      actions: [el("a", { class: "fl-btn subtle xs", href: `#runs?task_id=${encodeURIComponent(taskId)}` }, el("span", null, "全部运行"), icon("chevron-right", 13))],
    })
  );
  if (!taskRuns.length) {
    historyCard.appendChild(emptyState("暂无运行历史记录", "terminal", "还没有运行记录"));
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
              el("td", { "data-label": "ID" }, el("a", { href: `#runs/${r.id}` }, `#${r.id}`)),
              el("td", { "data-label": "状态" }, statusBadge(r.status)),
              el("td", { "data-label": "新增 / 跳过" }, `+${r.downloaded_count ?? 0} / ${r.skipped_count ?? 0}`),
              el("td", { "data-label": "耗时" }, fmtDuration(r.duration_sec)),
              el("td", { "data-label": "触发时间" }, fmtTimeShort(r.created_at)),
              el("td", { "data-label": "操作" }, el("a", { class: "fl-btn subtle xs", href: `#runs/${r.id}` }, el("span", null, "日志")))
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
      { class: "page-body" },
      breadcrumb([{ label: "定时任务", href: "#tasks" }, { label: currentName || `任务 #${task.id}` }]),
      pageHead({
        eyebrow: "Task detail",
        title: [titleTextNode, ...matchedSites.map((s) => el("a", { class: "fl-badge info", href: `#site/${encodeURIComponent(s)}` }, SITE_LABELS[s] || s))],
        subtitle: subtitleTextNode,
        actions: [
          enablePill,
          el("button", { type: "button", class: "fl-btn sm", onClick: () => runNow(true) }, icon("play", 14), el("span", null, "模拟试跑")),
          el("button", { type: "button", class: "fl-btn accent sm", onClick: () => runNow(false) }, icon("zap", 14), el("span", null, "立即运行")),
        ],
      }),
      form,
      historyCard
    )
  );

  return () => {
    destroyed = true;
  };
}
