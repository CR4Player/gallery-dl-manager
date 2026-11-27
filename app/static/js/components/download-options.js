import { api } from "../api.js";
import { el, debounce, copyText, detectSiteFromUrl } from "../util.js";
import { createOverrideField } from "./override-field.js";

/**
 * Shared download/task options panel + live effective config preview.
 * Keeps SQLite Archive deduplication and ExifTool postprocessing clearly separated.
 */
export function createDownloadOptions({
  initial = {},
  overview = null,
  getContextUrl = () => "",
  onChange = () => {},
} = {}) {
  const globalCfg = overview?.global_config || overview?.settings || {};

  const state = {
    proxy_mode: initial.proxy_mode || "inherit",
    proxy_url: initial.proxy_url || "",
    skip_mode: initial.skip_mode || "inherit",
    skip_value: initial.skip_value || "",
    sleep_request: initial.sleep_request ?? null,
    output_subdir: initial.output_subdir || "",
    filename: initial.filename || "",
    extra_args: initial.extra_args || "",
    archive_enabled: initial.archive_enabled ?? null,
    archive_backfill: Boolean(initial.archive_backfill),
    postprocess_mode: initial.postprocess_mode || "inherit",
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
    el("option", { value: "inherit", selected: state.proxy_mode === "inherit" }, "继承默认（全局/站点）"),
    el("option", { value: "global", selected: state.proxy_mode === "global" }, "强制使用全局代理"),
    el("option", { value: "direct", selected: state.proxy_mode === "direct" }, "强制直连（绕过代理）"),
    el("option", { value: "custom", selected: state.proxy_mode === "custom" }, "自定义代理地址")
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
        state.skip_mode = e.target.value;
        skipValField.classList.toggle("hidden", state.skip_mode !== "enable");
        emitChange();
      },
    },
    el("option", { value: "inherit", selected: state.skip_mode === "inherit" }, `继承默认 (${globalCfg.skip || "abort:7"})`),
    el("option", { value: "enable", selected: state.skip_mode === "enable" }, "自定义 Skip 阈值"),
    el("option", { value: "disable", selected: state.skip_mode === "disable" }, "禁用跳过限制（全量扫描）")
  );
  const skipValInput = el("input", {
    type: "text",
    value: state.skip_value,
    placeholder: "例如 abort:10 或 enumerate",
    onInput: (e) => {
      state.skip_value = e.target.value;
      emitChange();
    },
  });
  const skipValField = el(
    "div",
    { class: `field${state.skip_mode === "enable" ? "" : " hidden"}` },
    el("label", null, "Skip 规则值"),
    skipValInput
  );

  // Sleep override
  const sleepField = createOverrideField({
    label: "请求间隔 (sleep-request 秒)",
    value: state.sleep_request,
    type: "number",
    min: 0,
    step: "0.5",
    defaultCustomValue: 1.5,
    inheritedSource: "全局/站点默认",
    inheritedText: globalCfg["sleep-request"] ? `${globalCfg["sleep-request"]} s` : "由站点规则决定",
    onChange: (val) => {
      state.sleep_request = val;
      emitChange();
    },
  });

  // Output subdir & filename
  const subdirInput = el("input", {
    type: "text",
    value: state.output_subdir,
    placeholder: "例如 twitter-likes（相对于下载根目录）",
    onInput: (e) => {
      state.output_subdir = e.target.value;
      emitChange();
    },
  });
  const filenameInput = el("input", {
    type: "text",
    value: state.filename,
    placeholder: "留空沿用站点/全局文件名模板",
    onInput: (e) => {
      state.filename = e.target.value;
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

  // Card 1: SQLite Archive 去重 (strictly separated from ExifTool!)
  const archiveSelect = el(
    "select",
    {
      onChange: (e) => {
        const v = e.target.value;
        state.archive_enabled = v === "inherit" ? null : v === "true";
        emitChange();
      },
    },
    el("option", { value: "inherit", selected: state.archive_enabled === null }, "继承全局设置"),
    el("option", { value: "true", selected: state.archive_enabled === true }, "启用 SQLite Archive 去重"),
    el("option", { value: "false", selected: state.archive_enabled === false }, "禁用 Archive（允许重复下载）")
  );
  const archiveBackfillToggle = el("input", {
    type: "checkbox",
    role: "switch",
    switch: true,
    checked: state.archive_backfill,
    onChange: (e) => {
      state.archive_backfill = e.target.checked;
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
      el("span", { class: "fl-badge neutral" }, "防重复抓取")
    ),
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "去重策略"), archiveSelect),
      el(
        "div",
        { class: "field", style: { justifyContent: "flex-end" } },
        el(
          "label",
          { class: "switch-inline" },
          archiveBackfillToggle,
          el("span", null, "跳过已存在文件时回填记录")
        )
      )
    )
  );

  // Card 2: ExifTool 后处理 (strictly separated!)
  const postSelect = el(
    "select",
    {
      onChange: (e) => {
        state.postprocess_mode = e.target.value;
        emitChange();
      },
    },
    el("option", { value: "inherit", selected: state.postprocess_mode === "inherit" }, "继承站点默认后处理规则"),
    el("option", { value: "enable", selected: state.postprocess_mode === "enable" }, "强制启用 ExifTool 元数据写入"),
    el("option", { value: "disable", selected: state.postprocess_mode === "disable" }, "禁用后处理（保留原始文件）")
  );
  const postCard = el(
    "div",
    { class: "fl-sub-card stack sm-gap" },
    el(
      "div",
      { class: "label-row" },
      el("span", { class: "fl-subcard-title" }, "ExifTool 后处理"),
      el("span", { class: "fl-badge neutral" }, "元数据与标签")
    ),
    el("div", { class: "field" }, el("label", null, "后处理模式"), postSelect),
    el("div", { class: "muted xs" }, "开启后将在下载完成后自动写入来源 URL、作者、标签与拍摄时间等 EXIF/XMP 元数据。")
  );

  // Effective Config Live Preview
  const cmdCode = el("pre", { class: "cmd-preview" }, "gallery-dl --config /tmp/effective.json <待输入 URL>");
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
      el("code", { title: String(value) }, String(value || "—"))
    );
  }

  function renderLocalFallbackPreview() {
    const rawUrl = (getContextUrl() || "").split(/\r?\n/).find((l) => l.trim()) || "";
    const site = detectSiteFromUrl(rawUrl);
    const outDir = state.output_subdir ? `/gallery-dl/${state.output_subdir}` : "/gallery-dl";
    const proxyVal =
      state.proxy_mode === "direct"
        ? "直连 (none)"
        : state.proxy_mode === "custom"
          ? state.proxy_url || "<未填写>"
          : globalCfg.proxy || "未配置";
    const proxySrc = state.proxy_mode === "inherit" ? "默认" : "任务覆盖";
    const skipVal =
      state.skip_mode === "disable"
        ? "已禁用"
        : state.skip_mode === "enable"
          ? state.skip_value || "自定义"
          : globalCfg.skip || "abort:7";
    const skipSrc = state.skip_mode === "inherit" ? "全局设置" : "任务覆盖";
    const archVal =
      state.archive_enabled === true ? "已启用" : state.archive_enabled === false ? "已禁用" : "继承全局";

    cmdCode.textContent = `gallery-dl --config /tmp/effective.json${state.extra_args ? " " + state.extra_args : ""} ${rawUrl || (site ? `<${site}>` : "<待输入 URL>")}`;
    effGrid.innerHTML = "";
    effGrid.append(
      renderEffCard("输出目录", state.output_subdir ? "子目录" : "默认", outDir),
      renderEffCard("代理", proxySrc, proxyVal),
      renderEffCard("Skip", skipSrc, skipVal),
      renderEffCard("Archive / 后处理", state.postprocess_mode === "inherit" ? "站点默认" : "覆盖", archVal)
    );
  }

  const fetchEffective = debounce(async () => {
    const rawUrl = (getContextUrl() || "").split(/\r?\n/).find((l) => l.trim()) || "";
    try {
      const res = await api.post("/api/config/effective", {
        url: rawUrl,
        overrides: { ...state },
      });
      if (!res) {
        renderLocalFallbackPreview();
        return;
      }
      cmdCode.textContent = res.command_preview || res.command || cmdCode.textContent;
      const items = res.summary || res.fields;
      effGrid.innerHTML = "";
      if (Array.isArray(items) && items.length) {
        for (const it of items) {
          effGrid.appendChild(renderEffCard(it.label || it.key, it.source || "生效", it.value));
        }
      } else {
        effGrid.append(
          renderEffCard("输出目录", res.output_source || "默认", res.base_directory || state.output_subdir || "/gallery-dl"),
          renderEffCard("代理", res.proxy_source || "继承", res.proxy ?? "直连"),
          renderEffCard("Skip", res.skip_source || "继承", res.skip ?? "abort:7"),
          renderEffCard("Archive", res.archive_source || "继承", res.archive ? "启用" : "未启用")
        );
      }
    } catch {
      renderLocalFallbackPreview();
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
      skip_value: state.skip_mode === "enable" ? state.skip_value.trim() : "",
      sleep_request: state.sleep_request === "" ? null : state.sleep_request,
      output_subdir: state.output_subdir.trim(),
      filename: state.filename.trim(),
      extra_args: state.extra_args.trim(),
      archive_enabled: state.archive_enabled,
      archive_backfill: Boolean(state.archive_backfill),
      postprocess_mode: state.postprocess_mode,
    };
  }

  root.append(
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "代理策略"), proxySelect),
      el("div", { class: "field" }, el("label", null, "Skip 策略"), skipSelect)
    ),
    proxyUrlField,
    skipValField,
    el(
      "div",
      { class: "form-grid-2" },
      el("div", { class: "field" }, el("label", null, "输出子目录"), subdirInput),
      el("div", { class: "field" }, el("label", null, "文件名模板覆盖"), filenameInput)
    ),
    el(
      "div",
      { class: "form-grid-2" },
      sleepField.el,
      el("div", { class: "field" }, el("label", null, "额外 CLI 参数"), extraArgsInput)
    ),
    archiveCard,
    postCard,
    previewBox
  );

  renderLocalFallbackPreview();
  fetchEffective();

  return {
    el: root,
    getPayload,
    refreshPreview: fetchEffective,
  };
}
