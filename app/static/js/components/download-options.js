import { api } from "../api.js";
import { el, debounce, copyText } from "../util.js";

const SOURCE_LABELS = {
  global: "全局设置",
  task: "任务覆盖",
  direct: "直连",
  default: "默认",
};

function formatSource(src) {
  if (!src) return "默认";
  if (SOURCE_LABELS[src]) return SOURCE_LABELS[src];
  if (src.startsWith("site:")) return `站点 ${src.slice(5)}`;
  return src;
}

/**
 * Shared download/task options panel + live effective config preview.
 * Strictly aligned with app/api.py & app/insights.py (`compute_effective_config`).
 */
export function createDownloadOptions({
  initial = {},
  overview = null,
  taskId = null,
  getContextUrls = () => "",
  getInputFile = () => "",
  getSimulate = () => false,
  onChange = () => {},
} = {}) {
  const settings = overview?.settings || {};
  const globalProxy = settings.global_proxy || "";
  const defaultSkip = overview?.default_skip || "abort:7";

  const PRESET_SKIPS = new Set(["", "abort:5", "abort:7", "abort:10", "true", "false"]);
  const initSkip = String(initial.skip_mode || "");
  const isCustomInitSkip = initSkip && !PRESET_SKIPS.has(initSkip);

  const state = {
    proxy_mode: initial.proxy_mode || "inherit",
    proxy_url: initial.proxy_url || "",
    skip_mode: initSkip,
    subdir: initial.subdir || "",
    filename_format: initial.filename_format || "",
    extra_args: initial.extra_args || "",
    use_archive: Boolean(initial.use_archive),
    archive_backfill: Boolean(initial.archive_backfill),
    postprocess_mode: initial.postprocess_mode || "inherit",
    postprocess_date_field: initial.postprocess_date_field || "",
    postprocess_command: initial.postprocess_command || "",
  };

  const root = el("div", { class: "stack" });

  // Proxy row
  const proxySelect = el(
    "select",
    {
      onChange: (e) => {
        state.proxy_mode = e.target.value;
        proxyUrlField.classList.toggle("hidden", state.proxy_mode !== "custom");
        emitChange();
      },
    },
    el("option", { value: "inherit", selected: state.proxy_mode === "inherit" }, globalProxy ? `跟随全局 (${globalProxy})` : "跟随全局（当前直连）"),
    el("option", { value: "direct", selected: state.proxy_mode === "direct" }, "强制直连（绕过代理）"),
    el("option", { value: "custom", selected: state.proxy_mode === "custom" }, "自定义代理 URL")
  );
  const proxyUrlInput = el("input", {
    type: "text",
    value: state.proxy_url,
    placeholder: "http://127.0.0.1:7890 或 socks5://...",
    onInput: (e) => {
      state.proxy_url = e.target.value;
      emitChange();
    },
  });
  const proxyUrlField = el(
    "div",
    { class: `field${state.proxy_mode === "custom" ? "" : " hidden"}` },
    el("label", null, "自定义代理 URL"),
    proxyUrlInput
  );

  // Skip row
  const skipSelect = el(
    "select",
    {
      onChange: (e) => {
        const val = e.target.value;
        if (val === "__custom__") {
          skipCustomField.classList.remove("hidden");
          state.skip_mode = skipCustomInput.value.trim();
        } else {
          skipCustomField.classList.add("hidden");
          state.skip_mode = val;
        }
        emitChange();
      },
    },
    el("option", { value: "", selected: state.skip_mode === "" }, `继承默认 (${defaultSkip})`),
    el("option", { value: "abort:5", selected: state.skip_mode === "abort:5" }, "连续 5 个已存在即中止 (abort:5)"),
    el("option", { value: "abort:7", selected: state.skip_mode === "abort:7" }, "连续 7 个已存在即中止 (abort:7)"),
    el("option", { value: "abort:10", selected: state.skip_mode === "abort:10" }, "连续 10 个已存在即中止 (abort:10)"),
    el("option", { value: "true", selected: state.skip_mode === "true" }, "遇到已存在跳过但不中止 (true)"),
    el("option", { value: "false", selected: state.skip_mode === "false" }, "全量覆盖检查 (false)"),
    el("option", { value: "__custom__", selected: isCustomInitSkip }, "自定义 Skip 规则…")
  );
  const skipCustomInput = el("input", {
    type: "text",
    value: isCustomInitSkip ? state.skip_mode : "",
    placeholder: "例如 abort:20 或 enumerate",
    onInput: (e) => {
      state.skip_mode = e.target.value.trim();
      emitChange();
    },
  });
  const skipCustomField = el(
    "div",
    { class: `field${isCustomInitSkip ? "" : " hidden"}` },
    el("label", null, "自定义 Skip 值"),
    skipCustomInput
  );

  // Subdir, Filename, Extra args
  const subdirInput = el("input", {
    type: "text",
    value: state.subdir,
    placeholder: "例如 twitter-likes（相对于 /gallery-dl）",
    onInput: (e) => {
      state.subdir = e.target.value;
      emitChange();
    },
  });
  const filenameInput = el("input", {
    type: "text",
    value: state.filename_format,
    placeholder: "留空沿用站点或全局模板",
    onInput: (e) => {
      state.filename_format = e.target.value;
      emitChange();
    },
  });
  const extraArgsInput = el("input", {
    type: "text",
    value: state.extra_args,
    placeholder: "例如 --range 1-100 --filesize-max 50M",
    onInput: (e) => {
      state.extra_args = e.target.value;
      emitChange();
    },
  });

  // Card 1: SQLite Archive 去重 (strictly separated)
  const backfillToggle = el("input", {
    type: "checkbox",
    role: "switch",
    switch: true,
    checked: state.archive_backfill,
    disabled: !state.use_archive,
    onChange: (e) => {
      state.archive_backfill = e.target.checked;
      emitChange();
    },
  });
  const archiveToggle = el("input", {
    type: "checkbox",
    role: "switch",
    switch: true,
    checked: state.use_archive,
    onChange: (e) => {
      state.use_archive = e.target.checked;
      backfillToggle.disabled = !state.use_archive;
      if (!state.use_archive) {
        state.archive_backfill = false;
        backfillToggle.checked = false;
      }
      emitChange();
    },
  });
  const archiveCard = el(
    "div",
    { class: "fl-sub-card stack sm-gap" },
    el(
      "div",
      { class: "label-row" },
      el("span", { class: "fl-subcard-title" }, "SQLite Archive 去重"),
      el("span", { class: "fl-badge neutral" }, "/data/archive.sqlite3")
    ),
    el(
      "div",
      { class: "form-grid-2" },
      el(
        "label",
        { class: "switch-inline" },
        archiveToggle,
        el("span", null, "启用 Archive 记录去重")
      ),
      el(
        "label",
        { class: "switch-inline" },
        backfillToggle,
        el("span", null, "跳过已存在时自动回填 (skip)")
      )
    )
  );

  // Card 2: ExifTool 后处理 (strictly separated)
  const postDateField = el(
    "div",
    { class: `field${state.postprocess_mode === "enabled" ? "" : " hidden"}` },
    el("label", null, "日期元数据模板 (留空默认 {date:%Y-%m-%dT%H:%M:%S})"),
    el("input", {
      type: "text",
      value: state.postprocess_date_field,
      placeholder: "{date:%Y-%m-%dT%H:%M:%S}",
      onInput: (e) => {
        state.postprocess_date_field = e.target.value;
        emitChange();
      },
    })
  );
  const postCustomField = el(
    "div",
    { class: `field${state.postprocess_mode === "custom" ? "" : " hidden"}` },
    el("label", null, "自定义 exec 后处理指令"),
    el("input", {
      type: "text",
      value: state.postprocess_command,
      placeholder: "python3 /path/to/script.py {_path}",
      onInput: (e) => {
        state.postprocess_command = e.target.value;
        emitChange();
      },
    })
  );
  const postSelect = el(
    "select",
    {
      onChange: (e) => {
        state.postprocess_mode = e.target.value;
        postDateField.classList.toggle("hidden", state.postprocess_mode !== "enabled");
        postCustomField.classList.toggle("hidden", state.postprocess_mode !== "custom");
        emitChange();
      },
    },
    el("option", { value: "inherit", selected: state.postprocess_mode === "inherit" }, "按站点配置分别执行 (inherit)"),
    el("option", { value: "enabled", selected: state.postprocess_mode === "enabled" }, "强制启用内置 ExifTool 时间与元数据写入"),
    el("option", { value: "custom", selected: state.postprocess_mode === "custom" }, "自定义 exec 后处理指令"),
    el("option", { value: "disabled", selected: state.postprocess_mode === "disabled" }, "强制禁用后处理")
  );
  const postCard = el(
    "div",
    { class: "fl-sub-card stack sm-gap" },
    el(
      "div",
      { class: "label-row" },
      el("span", { class: "fl-subcard-title" }, "ExifTool 后处理"),
      el("span", { class: "fl-badge neutral" }, "元数据与拍摄时间")
    ),
    el("div", { class: "field" }, el("label", null, "后处理模式"), postSelect),
    postDateField,
    postCustomField
  );

  // Effective Config Live Preview
  const cmdCode = el("pre", { class: "cmd-preview" }, "gallery-dl -c /data/.runtime-conf.json <URL>");
  const effGrid = el("div", { class: "eff-grid" });
  const previewBox = el(
    "div",
    { class: "eff-preview-box stack sm-gap" },
    el(
      "div",
      { class: "label-row" },
      el("strong", { class: "sm" }, "生效配置实时预览"),
      el(
        "button",
        {
          type: "button",
          class: "fl-btn subtle xs",
          onClick: () => copyText(cmdCode.textContent, "已复制有效 CLI 命令"),
        },
        "复制命令"
      )
    ),
    cmdCode,
    effGrid
  );

  function renderEffCard(title, source, value) {
    return el(
      "div",
      { class: "eff-item" },
      el(
        "div",
        { class: "eff-item-top" },
        el("span", { class: "muted xs" }, title),
        el("span", { class: "fl-badge neutral" }, source)
      ),
      el("code", { title: String(value || "") }, String(value || "—"))
    );
  }

  function renderLocalFallback() {
    const outDir = state.subdir.trim() ? `/gallery-dl/${state.subdir.trim()}` : "/gallery-dl";
    const proxyVal =
      state.proxy_mode === "direct"
        ? "直连 (无代理)"
        : state.proxy_mode === "custom"
          ? state.proxy_url || "<未填写>"
          : globalProxy || "直连 (未配全局代理)";
    effGrid.replaceChildren(
      renderEffCard("输出目录", state.subdir.trim() ? "任务覆盖" : "默认", outDir),
      renderEffCard("代理", state.proxy_mode === "direct" ? "直连" : state.proxy_mode === "custom" ? "任务覆盖" : globalProxy ? "全局设置" : "直连", proxyVal),
      renderEffCard("Skip", state.skip_mode ? "任务覆盖" : "全局/默认", state.skip_mode || defaultSkip),
      renderEffCard("Archive", state.use_archive ? (state.archive_backfill ? "启用+回填" : "已启用") : "未启用", state.use_archive ? "/data/archive.sqlite3" : "未启用")
    );
  }

  const fetchEffective = debounce(async () => {
    const rawUrls = String(getContextUrls() || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    try {
      const res = await api.post("/api/config/effective", {
        ...(taskId ? { task_id: Number(taskId) } : {}),
        urls: rawUrls,
        input_file: getInputFile() || "",
        simulate: Boolean(getSimulate()),
        ...getPayload(),
      });
      if (!res || !res.fields) {
        renderLocalFallback();
        return;
      }
      cmdCode.textContent = res.command || cmdCode.textContent;
      const f = res.fields;
      const ppList = Array.isArray(f.postprocess) ? f.postprocess : [];
      const ppText = ppList.length
        ? ppList.map((p) => `${p.site === "*" ? "全部" : p.site}(${p.mode})`).join(", ")
        : "未启用";

      effGrid.replaceChildren(
        renderEffCard("输出目录", formatSource(f.subdir?.source), res.base_directory || f.subdir?.value || "/gallery-dl"),
        renderEffCard("代理", formatSource(f.proxy?.source), f.proxy?.value || "直连"),
        renderEffCard("Skip", formatSource(f.skip?.source), String(f.skip?.value ?? defaultSkip)),
        renderEffCard(
          "Archive / 后处理",
          f.archive?.value ? (f.archive?.backfill ? "回填" : "去重") : "未启用",
          `${f.archive?.value ? "Archive 开" : "Archive 关"} · ${ppText}`
        )
      );
    } catch {
      renderLocalFallback();
    }
  }, 220);

  function emitChange() {
    onChange(getPayload());
    fetchEffective();
  }

  function getPayload() {
    return {
      proxy_mode: state.proxy_mode,
      proxy_url: state.proxy_mode === "custom" ? state.proxy_url.trim() : "",
      skip_mode: state.skip_mode,
      subdir: state.subdir.trim(),
      filename_format: state.filename_format.trim(),
      extra_args: state.extra_args.trim(),
      use_archive: Boolean(state.use_archive),
      archive_backfill: Boolean(state.use_archive && state.archive_backfill),
      postprocess_mode: state.postprocess_mode,
      postprocess_date_field: state.postprocess_mode === "enabled" ? state.postprocess_date_field.trim() : "",
      postprocess_command: state.postprocess_mode === "custom" ? state.postprocess_command.trim() : "",
    };
  }

  root.append(
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "代理策略"), proxySelect),
      el("div", { class: "field" }, el("label", null, "Skip 增量中止策略"), skipSelect)
    ),
    proxyUrlField,
    skipCustomField,
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "输出子目录"), subdirInput),
      el("div", { class: "field" }, el("label", null, "文件名模板覆盖"), filenameInput)
    ),
    el("div", { class: "field" }, el("label", null, "额外 CLI 参数"), extraArgsInput),
    archiveCard,
    postCard,
    previewBox
  );

  renderLocalFallback();
  fetchEffective();

  return {
    el: root,
    getPayload,
    refreshPreview: fetchEffective,
  };
}
