import "./override-field.js";
import { api, getConfigOverview } from "../api.js";
import { debounce, esc, showToast, upgradeSwitches } from "../util.js";

function formatSourceLabel(src) {
  if (!src || src === "default") return "默认";
  if (src === "global") return "全局设置";
  if (src === "direct") return "直连";
  if (src === "task") return "当前覆盖";
  if (src.startsWith("site:")) return `站点 ${src.slice(5)}`;
  return src;
}

/**
 * Shared download/task option fields + live effective config preview panel.
 */
export function mountDownloadOptions(container, { initial = {}, getContext = () => ({}), onChange = () => {} } = {}) {
  const uid = Math.random().toString(36).slice(2, 8);
  let destroyed = false;

  container.innerHTML = `
    <div class="stack">
      <div class="form-grid-2">
        <div class="field">
          <label for="do-proxy-mode-${uid}">代理策略</label>
          <select id="do-proxy-mode-${uid}">
            <option value="inherit">跟随全局代理</option>
            <option value="direct">直连（不用代理）</option>
            <option value="custom">自定义代理</option>
          </select>
          <span class="hint" id="do-proxy-hint-${uid}">继承全局设置</span>
        </div>
        <div class="field hidden" id="do-proxy-url-wrap-${uid}">
          <label for="do-proxy-url-${uid}">自定义代理地址</label>
          <input id="do-proxy-url-${uid}" type="text" placeholder="http://host.docker.internal:7890">
        </div>
      </div>

      <div class="form-grid-2">
        <override-field id="do-skip-${uid}" label="Skip 策略" placeholder="如 abort:10 / exit:10 / true" hint="达到连续跳过次数即中止增量扫描"></override-field>
        <override-field id="do-filename-${uid}" label="文件命名模板" placeholder="[{date:%Y-%m-%d}] {id}.{extension}" hint="留空沿用站点或全局默认规则"></override-field>
        <override-field id="do-subdir-${uid}" label="输出子目录" placeholder="相对路径，如 twitter-likes" hint="写入 /gallery-dl/<子目录>"></override-field>
        <override-field id="do-extra-${uid}" label="额外 CLI 参数" placeholder="例如 --range 1-100" hint="直接附加到 gallery-dl 命令行"></override-field>
      </div>

      <div class="sub-panel stack sm-gap">
        <div class="form-grid-2">
          <div class="field">
            <label for="do-pp-mode-${uid}">ExifTool 后处理</label>
            <select id="do-pp-mode-${uid}">
              <option value="inherit">按站点默认规则</option>
              <option value="enabled">内置 ExifTool（写入时区与 mtime）</option>
              <option value="custom">自定义 exec 指令</option>
              <option value="disabled">禁用后处理</option>
            </select>
          </div>
          <div class="field" style="justify-content:end;">
            <div class="stack xs-gap">
              <label class="checkbox-inline">
                <input type="checkbox" switch role="switch" id="do-archive-${uid}"> 启用 SQLite Archive 去重
              </label>
              <label class="checkbox-inline">
                <input type="checkbox" switch role="switch" id="do-backfill-${uid}" disabled> 跳过时回填 Archive (file+skip)
              </label>
            </div>
          </div>
        </div>

        <div id="do-pp-date-wrap-${uid}" class="field hidden">
          <div class="label-row">
            <label for="do-pp-date-${uid}">日期字段模板</label>
            <button type="button" class="btn ghost xs" id="do-probe-btn-${uid}">探测 -K 字段</button>
          </div>
          <input id="do-pp-date-${uid}" type="text" value="{date:%Y-%m-%dT%H:%M:%S}" placeholder="{date:%Y-%m-%dT%H:%M:%S}">
          <div id="do-probe-result-${uid}" class="stack xs-gap hidden"></div>
        </div>

        <div id="do-pp-cmd-wrap-${uid}" class="field hidden">
          <label for="do-pp-cmd-${uid}">自定义 exec 指令（支持 {_path} 及元数据占位符）</label>
          <textarea id="do-pp-cmd-${uid}" rows="2" class="mono-area" placeholder='exiftool -overwrite_original -DateTimeOriginal="{date:%Y:%m:%d %H:%M:%S}" "{_path}"'></textarea>
        </div>

        <pre id="do-pp-preview-${uid}" class="cmd-preview hidden"></pre>
      </div>

      <section class="effective-panel stack sm-gap" aria-live="polite">
        <div class="row-actions between">
          <strong class="sm">生效配置预览</strong>
          <button type="button" class="btn ghost xs" id="do-copy-cmd-${uid}">复制命令</button>
        </div>
        <pre id="do-eff-cmd-${uid}" class="cmd-preview">正在解析生效配置…</pre>
        <div id="do-eff-fields-${uid}" class="eff-grid"></div>
        <div id="do-eff-pp-${uid}" class="stack xs-gap"></div>
        <details id="do-eff-json-details-${uid}">
          <summary class="details-summary xs muted">查看合并后的运行时 JSON（密钥已脱敏）</summary>
          <pre id="do-eff-json-${uid}" class="cmd-preview" style="margin-top:0.45rem; max-height:240px; overflow:auto;"></pre>
        </details>
      </section>
    </div>
  `;
  upgradeSwitches(container);

  const elProxyMode = document.getElementById(`do-proxy-mode-${uid}`);
  const elProxyWrap = document.getElementById(`do-proxy-url-wrap-${uid}`);
  const elProxyUrl = document.getElementById(`do-proxy-url-${uid}`);
  const elProxyHint = document.getElementById(`do-proxy-hint-${uid}`);
  const elSkip = document.getElementById(`do-skip-${uid}`);
  const elFilename = document.getElementById(`do-filename-${uid}`);
  const elSubdir = document.getElementById(`do-subdir-${uid}`);
  const elExtra = document.getElementById(`do-extra-${uid}`);
  const elPpMode = document.getElementById(`do-pp-mode-${uid}`);
  const elPpDateWrap = document.getElementById(`do-pp-date-wrap-${uid}`);
  const elPpDate = document.getElementById(`do-pp-date-${uid}`);
  const elPpCmdWrap = document.getElementById(`do-pp-cmd-wrap-${uid}`);
  const elPpCmd = document.getElementById(`do-pp-cmd-${uid}`);
  const elPpPreview = document.getElementById(`do-pp-preview-${uid}`);
  const elArchive = document.getElementById(`do-archive-${uid}`);
  const elBackfill = document.getElementById(`do-backfill-${uid}`);
  const elProbeBtn = document.getElementById(`do-probe-btn-${uid}`);
  const elProbeOut = document.getElementById(`do-probe-result-${uid}`);
  const elEffCmd = document.getElementById(`do-eff-cmd-${uid}`);
  const elEffFields = document.getElementById(`do-eff-fields-${uid}`);
  const elEffPp = document.getElementById(`do-eff-pp-${uid}`);
  const elEffJson = document.getElementById(`do-eff-json-${uid}`);
  const elCopyCmd = document.getElementById(`do-copy-cmd-${uid}`);

  function getValues() {
    const useArch = elArchive.checked;
    return {
      proxy_mode: elProxyMode.value,
      proxy_url: elProxyUrl.value.trim(),
      skip_mode: elSkip.value.trim(),
      filename_format: elFilename.value.trim(),
      subdir: elSubdir.value.trim(),
      extra_args: elExtra.value.trim(),
      use_archive: useArch,
      archive_backfill: useArch && elBackfill.checked,
      postprocess_mode: elPpMode.value,
      postprocess_date_field: elPpDate.value.trim(),
      postprocess_command: elPpCmd.value.trim(),
    };
  }

  function syncVisibility() {
    elProxyWrap.classList.toggle("hidden", elProxyMode.value !== "custom");
    const pp = elPpMode.value;
    elPpDateWrap.classList.toggle("hidden", pp !== "enabled");
    elPpCmdWrap.classList.toggle("hidden", pp !== "custom");
    elPpPreview.classList.toggle("hidden", pp === "inherit" || pp === "disabled");
    elBackfill.disabled = !elArchive.checked;
    if (!elArchive.checked) elBackfill.checked = false;
  }

  function setValues(vals = {}) {
    elProxyMode.value = vals.proxy_mode || "inherit";
    elProxyUrl.value = vals.proxy_url || "";
    elSkip.value = vals.skip_mode || "";
    elFilename.value = vals.filename_format || "";
    elSubdir.value = vals.subdir || "";
    elExtra.value = vals.extra_args || "";
    elArchive.checked = Boolean(vals.use_archive);
    elBackfill.checked = Boolean(vals.use_archive && vals.archive_backfill);
    elPpMode.value = vals.postprocess_mode || "inherit";
    elPpDate.value = vals.postprocess_date_field || "{date:%Y-%m-%dT%H:%M:%S}";
    elPpCmd.value = vals.postprocess_command || "";
    syncVisibility();
  }

  async function refreshInheritedDefaults() {
    try {
      const ov = await getConfigOverview();
      const gp = ov.settings?.global_proxy || "";
      elProxyHint.textContent = gp ? `全局默认：${gp}` : "全局默认：直连（未配置代理）";
      elSkip.setInherited(ov.default_skip || "true (默认)", "全局");
      elFilename.setInherited("站点默认模板", "默认");
      elSubdir.setInherited("/gallery-dl", "默认根目录");
      elExtra.setInherited("无", "默认");
    } catch {}
  }

  async function refreshPostprocessPreview() {
    const pp = elPpMode.value;
    if (pp !== "enabled" && pp !== "custom") return;
    try {
      const res = await api("/api/config/postprocess-preview", {
        method: "POST",
        body: {
          mode: pp === "custom" ? "custom" : "builtin",
          date_template: elPpDate.value.trim(),
          custom_command: elPpCmd.value.trim(),
        },
      });
      if (destroyed) return;
      const lines = [`exec: ${res.exec_command || ""}`];
      if (res.exiftool_image_cmd) lines.push(`图片: ${res.exiftool_image_cmd}`);
      if (res.exiftool_video_cmd) lines.push(`视频: ${res.exiftool_video_cmd}`);
      elPpPreview.textContent = lines.join("\n");
    } catch (err) {
      if (!destroyed) elPpPreview.textContent = err.message;
    }
  }

  async function refreshEffective() {
    if (destroyed) return;
    const ctx = getContext() || {};
    const vals = getValues();
    try {
      const res = await api("/api/config/effective", {
        method: "POST",
        body: { ...vals, ...ctx },
      });
      if (destroyed) return;
      elEffCmd.textContent = res.command || "";
      elEffJson.textContent = res.config_json || "{}";

      const f = res.fields || {};
      if (f.skip && f.skip.source !== "task") {
        elSkip.setInherited(String(f.skip.value ?? ""), formatSourceLabel(f.skip.source));
      }
      if (f.filename && f.filename.source !== "task") {
        elFilename.setInherited(String(f.filename.value ?? ""), formatSourceLabel(f.filename.source));
      }

      const items = [
        { label: "输出目录", value: res.base_directory || "/gallery-dl", source: f.subdir?.source || "default" },
        { label: "代理", value: f.proxy?.value || "直连", source: f.proxy?.source || "direct" },
        { label: "Skip", value: String(f.skip?.value ?? "默认"), source: f.skip?.source || "default" },
        { label: "命名模板", value: String(f.filename?.value ?? "默认"), source: f.filename?.source || "default" },
        {
          label: "SQLite Archive",
          value: f.archive?.value ? (f.archive.backfill ? "已启用 + 回填" : "已启用") : "未启用",
          source: f.archive?.value ? "task" : "default",
        },
      ];
      elEffFields.innerHTML = items
        .map(
          (it) => `
        <div class="eff-item">
          <div class="eff-item-top">
            <span>${esc(it.label)}</span>
            <span class="ov-source-tag ${it.source === "task" ? "is-task" : ""}">${esc(formatSourceLabel(it.source))}</span>
          </div>
          <code class="xs" style="word-break:break-all;">${esc(it.value)}</code>
        </div>`
        )
        .join("");

      const pps = f.postprocess || [];
      elEffPp.innerHTML = pps.length
        ? `<div class="xs muted">生效后处理：</div>` +
          pps
            .map(
              (p) =>
                `<div class="xs"><code>[${esc(p.site)}]</code> <span class="ov-source-tag">${esc(formatSourceLabel(p.source))}</span> <code>${esc(p.exec_command)}</code></div>`
            )
            .join("")
        : `<div class="xs muted">后处理：无</div>`;
    } catch {
      if (destroyed) return;
      elEffCmd.textContent = "生效配置预览暂不可用（可直接保存或提交）";
      elEffFields.innerHTML = "";
      elEffPp.innerHTML = "";
      elEffJson.textContent = "";
    }
  }

  const debouncedRefresh = debounce(() => {
    refreshPostprocessPreview();
    refreshEffective();
    onChange(getValues());
  }, 260);

  container.addEventListener("input", () => {
    syncVisibility();
    debouncedRefresh();
  });
  container.addEventListener("change", () => {
    syncVisibility();
    debouncedRefresh();
  });

  elCopyCmd.addEventListener("click", async () => {
    const txt = elEffCmd.textContent || "";
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      showToast("已复制命令行预览");
    } catch {
      showToast("复制失败，请手动选中复制", "danger");
    }
  });

  elProbeBtn.addEventListener("click", async () => {
    const ctx = getContext() || {};
    const rawUrls = String(ctx.urls || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("#") && !x.startsWith("file:"));
    const url = rawUrls[0] || "";
    if (!url) {
      showToast("请先在上方填写至少一个 HTTP/HTTPS URL 再探测", "danger");
      return;
    }
    elProbeBtn.disabled = true;
    elProbeOut.classList.remove("hidden");
    elProbeOut.innerHTML = `<span class="hint">正在执行 <code>gallery-dl -K --range 1</code> 探测字段…</span>`;
    try {
      const res = await api("/api/probe-metadata", {
        method: "POST",
        body: { url, proxy_mode: elProxyMode.value, proxy_url: elProxyUrl.value.trim() },
      });
      if (destroyed) return;
      if (!res.ok) {
        elProbeOut.innerHTML = `<div class="notice warn xs">${esc(res.error || "探测失败")}</div>`;
      } else {
        const keys = res.keys || [];
        const top = keys.slice(0, 18);
        elProbeOut.innerHTML = top.length
          ? `<div class="hint">点击字段可直接填入日期模板：</div><div class="chip-group">${top
              .map(
                (k) =>
                  `<button type="button" class="chip-btn ${k.is_date ? "active" : ""}" data-probe-key="${esc(k.key)}" title="${esc(k.sample || "")}">{${esc(k.key)}}</button>`
              )
              .join("")}</div>`
          : `<div class="hint">未解析出可用字段。</div>`;
      }
    } catch (err) {
      if (!destroyed) elProbeOut.innerHTML = `<div class="notice warn xs">${esc(err.message)}</div>`;
    } finally {
      if (!destroyed) elProbeBtn.disabled = false;
    }
  });

  elProbeOut.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-probe-key]");
    if (!btn) return;
    const key = btn.dataset.probeKey;
    elPpDate.value = `{${key}:%Y-%m-%dT%H:%M:%S}`;
    showToast(`已填入 {${key}:%Y-%m-%dT%H:%M:%S}`);
    debouncedRefresh();
  });

  setValues(initial);
  refreshInheritedDefaults();
  refreshPostprocessPreview();
  refreshEffective();

  return {
    getValues,
    setValues(vals) {
      setValues(vals);
      refreshPostprocessPreview();
      refreshEffective();
    },
    refreshEffective,
    destroy() {
      destroyed = true;
    },
  };
}
