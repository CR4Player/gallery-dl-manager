import { api } from "../api.js";
import { el, toast, confirmModal, healthBadge, copyText, SITE_LABELS, SITE_DOMAINS, debounce, fmtTimeShort } from "../util.js";
import { navigate } from "../router.js";
import { pageHead, cardHead, breadcrumb, field, metaList, infoBar } from "../ui.js";
import { icon } from "../icons.js";

export async function renderSiteDetail(container, route, ctx) {
  let destroyed = false;
  const site = route.site;
  if (!site) {
    navigate("#sites");
    return () => {
      destroyed = true;
    };
  }

  const [siteInfo, overviewRes, healthRes, twitterSync] = await Promise.all([
    api.get(`/api/config/site/${encodeURIComponent(site)}`),
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/sites/health").catch(() => null),
    site === "twitter" ? api.get("/api/twitter-sync/status").catch(() => null) : Promise.resolve(null),
  ]);
  if (destroyed) return;

  const info = siteInfo || { site, postprocess_config: {}, cookie_keys: [] };
  const healthItem = Array.isArray(healthRes?.sites)
    ? healthRes.sites.find((x) => x.site === site) || {}
    : {};
  const ppCfg = info.postprocess_config || {};
  const defaultSkip = overviewRes?.default_skip || "abort:7";
  const globalProxy = overviewRes?.settings?.global_proxy || "";

  // Credentials & Cookies inputs
  const usernameIn = el("input", {
    type: "text",
    value: info.username || "",
    placeholder: "账号 / Username（可选）",
  });
  const passwordIn = el("input", {
    type: "password",
    value: "",
    placeholder: info.has_password ? "已保存密码（留空保持不变）" : "密码（可选）",
  });
  const clearPasswordChk = el("input", {
    type: "checkbox",
    onChange: (e) => {
      passwordIn.disabled = e.target.checked;
    },
  });
  const apiKeyIn = el("input", {
    type: "password",
    value: "",
    placeholder: info.has_api_key ? "已保存 API Key（留空保持不变）" : "API Key（可选）",
  });
  const clearApiKeyChk = el("input", {
    type: "checkbox",
    onChange: (e) => {
      apiKeyIn.disabled = e.target.checked;
    },
  });
  const userIdIn = el("input", { type: "text", value: info.user_id || "", placeholder: "User ID（可选）" });
  const browserIn = el("input", { type: "text", value: info.browser || "", placeholder: "例如 firefox 或 chrome（可选）" });
  const uaIn = el("input", { type: "text", value: info.user_agent || "", placeholder: "自定义 User-Agent（可选）" });

  const cookiesIn = el("textarea", {
    rows: 4,
    placeholder:
      "粘贴任意格式的 Cookie（JSON 对象、EditThisCookie JSON 数组、Netscape cookies.txt 或 key=value; ...），留空保持现有已存 Cookie 不变",
  });
  const clearCookiesChk = el("input", {
    type: "checkbox",
    onChange: (e) => {
      cookiesIn.disabled = e.target.checked;
    },
  });

  // Site extractor skip & filename
  const skipIn = el("input", {
    type: "text",
    value: info.skip || "",
    placeholder: `留空继承全局 (${defaultSkip})`,
  });
  const filenameIn = el("input", {
    type: "text",
    value: info.filename || "",
    placeholder: "留空使用站点默认文件名模板",
  });

  // ExifTool site postprocess controls
  const ppEnabled = el("input", {
    type: "checkbox",
    role: "switch",
    switch: true,
    checked: Boolean(info.postprocess_enabled),
  });
  const ppModeSel = el(
    "select",
    null,
    el("option", { value: "builtin", selected: (ppCfg.mode || "builtin") === "builtin" }, "内置 ExifTool 时间与标签写入"),
    el("option", { value: "custom", selected: ppCfg.mode === "custom" }, "自定义 exec 后处理命令")
  );
  const ppDateIn = el("input", {
    type: "text",
    value: ppCfg.date_template || "{date:%Y-%m-%dT%H:%M:%S}",
    placeholder: "{date:%Y-%m-%dT%H:%M:%S}",
  });
  const ppExtraIn = el("input", {
    type: "text",
    value: ppCfg.extra_args || "",
    placeholder: "额外 ExifTool 参数，如 -TagsFromFile ...",
  });
  const ppCustomIn = el("input", {
    type: "text",
    value: ppCfg.custom_command || "",
    placeholder: 'python3 /path/script.py {_path} 或 JSON 数组 ["cmd", ...]',
  });

  const ppPreviewCmd = el("pre", { class: "cmd-preview" }, info.postprocess_preview?.exec_command || "(未启用)");
  const ppBuiltinBox = el(
    "div",
    { class: `form-grid-2${ppModeSel.value === "custom" ? " hidden" : ""}` },
    field("日期字段模板", ppDateIn),
    field("额外 ExifTool 参数", ppExtraIn)
  );
  const ppCustomBox = el(
    "div",
    { class: `field${ppModeSel.value === "custom" ? "" : " hidden"}` },
    el("label", null, "自定义指令"),
    ppCustomIn
  );

  const refreshPpPreview = debounce(async () => {
    if (!ppEnabled.checked) {
      ppPreviewCmd.textContent = "(已禁用)";
      return;
    }
    try {
      const res = await api.post("/api/config/postprocess-preview", {
        mode: ppModeSel.value,
        date_template: ppDateIn.value,
        extra_args: ppExtraIn.value,
        custom_command: ppCustomIn.value,
      });
      ppPreviewCmd.textContent = [
        res?.exec_command,
        res?.exiftool_image_cmd ? `\n# 图片命令:\n${res.exiftool_image_cmd}` : "",
        res?.exiftool_video_cmd ? `\n# 视频命令:\n${res.exiftool_video_cmd}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (err) {
      ppPreviewCmd.textContent = `预览失败: ${err.message}`;
    }
  }, 200);

  ppModeSel.addEventListener("change", () => {
    ppBuiltinBox.classList.toggle("hidden", ppModeSel.value === "custom");
    ppCustomBox.classList.toggle("hidden", ppModeSel.value !== "custom");
    refreshPpPreview();
  });
  [ppEnabled, ppDateIn, ppExtraIn, ppCustomIn].forEach((n) => n.addEventListener("input", refreshPpPreview));
  ppEnabled.addEventListener("change", refreshPpPreview);

  // Probe (-K) card
  const sampleDomain = (SITE_DOMAINS[site] || [`${site}.com`])[0];
  const probeUrlIn = el("input", {
    type: "url",
    placeholder: `https://${sampleDomain}/...`,
  });
  const probeCustomProxyIn = el("input", {
    type: "text",
    placeholder: "http://127.0.0.1:7890 或 socks5://...",
    class: "hidden",
  });
  const probeProxySel = el(
    "select",
    {
      onChange: (e) => {
        probeCustomProxyIn.classList.toggle("hidden", e.target.value !== "custom");
      },
    },
    el("option", { value: "inherit" }, globalProxy ? `全局代理 (${globalProxy})` : "直连（无全局代理）"),
    el("option", { value: "direct" }, "强制直连"),
    el("option", { value: "custom" }, "自定义代理")
  );
  const probeResultWrap = el("div", { class: "stack sm-gap hidden" });
  const runProbe = async () => {
    const u = probeUrlIn.value.trim();
    if (!u) {
      toast("请输入一个该站点的测试 URL", "danger");
      return;
    }
    probeBtn.disabled = true;
    probeBtn.textContent = "解析中…";
    probeResultWrap.classList.remove("hidden");
    probeResultWrap.replaceChildren(
      el("div", { class: "fl-infobar sm" }, "正在调用 gallery-dl -K 探测元信息与登录态…")
    );
    try {
      const res = await api.post("/api/probe-metadata", {
        url: u,
        proxy_mode: probeProxySel.value,
        proxy_url: probeProxySel.value === "custom" ? probeCustomProxyIn.value.trim() : "",
      });
      if (destroyed) return;
      const nodes = [];
      if (res?.ok) {
        toast("元数据探测完成");
        const keys = Array.isArray(res.keys) ? res.keys : [];
        if (keys.length) {
          nodes.push(
            el(
              "div",
              { class: "fl-sub-card stack xs-gap" },
              el("div", { class: "muted xs" }, `解析到 ${keys.length} 个元数据字段（点击日期字段可直接填入 ExifTool 日期模板，点击普通字段可复制占位符）：`),
              el(
                "div",
                { class: "row-actions xs-gap", style: { flexWrap: "wrap" } },
                ...keys.slice(0, 60).map((k) =>
                  el(
                    "button",
                    {
                      type: "button",
                      class: "fl-btn subtle xs",
                      title: k.sample ? `示例: ${k.sample}` : k.key,
                      onClick: () => {
                        if (k.is_date) {
                          ppDateIn.value = `{${k.key}:%Y-%m-%dT%H:%M:%S}`;
                          refreshPpPreview();
                          toast(`已将 {${k.key}:%Y-%m-%dT%H:%M:%S} 填入日期模板`);
                        } else {
                          copyText(`{${k.key}}`, `已复制 {${k.key}}`);
                        }
                      },
                    },
                    el("span", { class: `fl-badge ${k.is_date ? "ok" : "neutral"}` }, k.is_date ? "日期" : "字段"),
                    el("code", null, k.key),
                    k.sample ? el("span", { class: "muted xs truncate", style: { maxInlineSize: "140px" } }, k.sample) : null
                  )
                )
              )
            )
          );
        }
      } else {
        toast(res?.error || "探测返回异常", "danger");
        nodes.push(infoBar({ tone: "danger", title: "探测异常", body: res?.error || "未解析到字段" }));
      }
      if (res?.raw_preview) {
        nodes.push(
          el(
            "details",
            { class: "fl-expander" },
            el("summary", { class: "fl-expander-head" }, "查看原始 -K 输出"),
            el("div", { class: "fl-expander-body" }, el("pre", { class: "cmd-preview" }, res.raw_preview))
          )
        );
      }
      probeResultWrap.replaceChildren(...nodes);
    } catch (err) {
      if (destroyed) return;
      probeResultWrap.replaceChildren(infoBar({ tone: "danger", title: "探测失败", body: err.message }));
      toast(`探测失败：${err.message}`, "danger");
    } finally {
      probeBtn.disabled = false;
      probeBtn.textContent = "执行 -K 探测";
    }
  };
  const probeBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn sm",
      onClick: runProbe,
    },
    icon("zap", 14),
    "执行 -K 探测"
  );
  probeUrlIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runProbe();
    }
  });

  // Twitter Sync Panel (only when site === "twitter")
  let twitterCard = null;
  if (site === "twitter") {
    const tokenDisplay = el("code", null, twitterSync?.token || "未生成");
    const countSummary = el(
      "div",
      { class: "muted xs" },
      `总计 ${twitterSync?.count ?? 0} 条已去重 ID · Archive ${twitterSync?.sources?.archive_sqlite ?? 0} · 磁盘 ${twitterSync?.sources?.disk ?? 0} · like.js ${twitterSync?.sources?.archive_js ?? 0} · 浏览器 ${twitterSync?.sources?.browser ?? 0}`
    );
    const likeJsIn = el("textarea", {
      rows: 3,
      placeholder: "粘贴 X 存档中的 like.js 内容、推文 URL 或 Tweet ID 列表…",
    });
    const likeJsFileIn = el("input", {
      type: "file",
      accept: ".js,.json,.txt",
      class: "fl-file-input",
    });

    twitterCard = el(
      "section",
      { class: "fl-card stack" },
      cardHead("Twitter / X 永久红心同步", {
        iconName: "activity",
        subtitle: "从 like.js、磁盘目录与浏览器汇总去重后的推文 ID",
        actions: [el("span", { class: `status-pill ${twitterSync?.token ? "ok" : "neutral"}` }, twitterSync?.token ? "同步已就绪" : "待生成")],
      }),
      el(
        "div",
        { class: "fl-sub-card row-actions between" },
        el(
          "div",
          { class: "stack xs-gap", style: { minWidth: 0 } },
          el("div", { class: "row-actions xs-gap" }, el("span", { class: "muted xs" }, "Sync Token:"), tokenDisplay),
          countSummary
        ),
        el(
          "div",
          { class: "row-actions" },
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: () => copyText(tokenDisplay.textContent, "已复制 Sync Token"),
            },
            icon("copy", 14),
            "复制"
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                try {
                  const res = await api.post("/api/twitter-sync/token/rotate", {});
                  if (res?.token) {
                    tokenDisplay.textContent = res.token;
                    copyText(res.token, "已轮换并复制新 Sync Token");
                  }
                } catch (err) {
                  toast(`轮换 Token 失败：${err.message}`, "danger");
                }
              },
            },
            "轮换 Token"
          ),
          el(
            "a",
            {
              class: "fl-btn accent sm",
              href: "/api/twitter-sync/userscript.user.js",
              target: "_blank",
              rel: "noopener",
            },
            icon("download", 14),
            "油猴脚本"
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                try {
                  const res = await api.post("/api/twitter-sync/scan-disk", {});
                  toast(`扫描完成：共扫描 ${res?.scanned_files ?? 0} 个文件，新增回填 ${res?.inserted ?? 0} 条`);
                  countSummary.textContent = `总计 ${res?.count ?? 0} 条已去重 ID · Archive ${res?.sources?.archive_sqlite ?? 0} · 磁盘 ${res?.sources?.disk ?? 0} · like.js ${res?.sources?.archive_js ?? 0} · 浏览器 ${res?.sources?.browser ?? 0}`;
                } catch (err) {
                  toast(`扫描失败：${err.message}`, "danger");
                }
              },
            },
            icon("folder", 14),
            "扫描磁盘"
          )
        )
      ),
      field("导入 X 官方存档 like.js（支持直接选择文件或粘贴文本）", likeJsIn),
      el(
        "div",
        { class: "file-picker-row" },
        likeJsFileIn,
        el(
          "button",
          {
            type: "button",
            class: "fl-btn sm",
            onClick: async () => {
              const file = likeJsFileIn.files?.[0];
              if (!file) {
                toast("请先选择 like.js 文件", "danger");
                return;
              }
              try {
                const fd = new FormData();
                fd.append("file", file);
                const res = await api.post("/api/twitter-sync/import-like-js", fd);
                toast(`文件导入成功：解析 ${res?.parsed ?? 0} 条，新增入库 ${res?.inserted ?? 0} 条`);
                likeJsFileIn.value = "";
                countSummary.textContent = `总计 ${res?.count ?? 0} 条已去重 ID · Archive ${res?.sources?.archive_sqlite ?? 0} · 磁盘 ${res?.sources?.disk ?? 0} · like.js ${res?.sources?.archive_js ?? 0} · 浏览器 ${res?.sources?.browser ?? 0}`;
              } catch (err) {
                toast(`文件导入失败：${err.message}`, "danger");
              }
            },
          },
          icon("upload", 14),
          "上传并导入文件"
        ),
        el(
          "button",
          {
            type: "button",
            class: "fl-btn sm",
            onClick: async () => {
              const content = likeJsIn.value.trim();
              if (!content) {
                toast("请先粘贴 like.js 内容", "danger");
                return;
              }
              try {
                const res = await api.post("/api/twitter-sync/import-like-js", { content });
                toast(`解析 ${res?.parsed ?? 0} 条，新增入库 ${res?.inserted ?? 0} 条`);
                likeJsIn.value = "";
                countSummary.textContent = `总计 ${res?.count ?? 0} 条已去重 ID · Archive ${res?.sources?.archive_sqlite ?? 0} · 磁盘 ${res?.sources?.disk ?? 0} · like.js ${res?.sources?.archive_js ?? 0} · 浏览器 ${res?.sources?.browser ?? 0}`;
              } catch (err) {
                toast(`导入失败：${err.message}`, "danger");
              }
            },
          },
          "导入粘贴内容"
        )
      )
    );
  }

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, icon("save", 15), "保存站点配置");
  const cookieKeys = Array.isArray(info.cookie_keys) ? info.cookie_keys : [];

  const form = el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        saveBtn.disabled = true;
        try {
          const res = await api.put(`/api/config/site/${encodeURIComponent(site)}`, {
            username: usernameIn.value,
            password: passwordIn.value,
            clear_password: clearPasswordChk.checked,
            api_key: apiKeyIn.value,
            clear_api_key: clearApiKeyChk.checked,
            user_id: userIdIn.value,
            browser: browserIn.value,
            user_agent: uaIn.value,
            skip: skipIn.value,
            filename: filenameIn.value,
            cookies_input: cookiesIn.value,
            clear_cookies: clearCookiesChk.checked,
            postprocess_enabled: ppEnabled.checked,
            postprocess_type: ppModeSel.value,
            postprocess_date_field: ppDateIn.value,
            postprocess_extra_args: ppExtraIn.value,
            postprocess_command: ppCustomIn.value,
          });
          toast(`已保存「${SITE_LABELS[site] || site}」配置（当前 Cookie ${res?.cookie_count ?? 0} 项）`);
          await ctx?.refreshHeader?.();
          if (!destroyed) {
            await renderSiteDetail(container, route, ctx);
          }
        } catch (err) {
          toast(`保存失败：${err.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    el(
      "section",
      { class: "fl-card stack" },
      cardHead("Cookie 与站点认证凭据", {
        iconName: "key",
        subtitle: "支持 Netscape cookies.txt、JSON 数组与 Header 字符串自动识别",
      }),
      cookieKeys.length
        ? el(
            "div",
            { class: "fl-sub-card stack xs-gap" },
            el("span", { class: "muted xs" }, `当前已存储 ${cookieKeys.length} 个 Cookie 字段：`),
            el("div", { class: "cookie-chips" }, ...cookieKeys.map((k) => el("span", { class: "fl-badge info" }, k)))
          )
        : infoBar({ tone: "", iconName: "info", title: "尚未保存站点 Cookie", body: "需要登录态的站点请在此粘贴 Cookie 或填写账号信息。" }),
      field("粘贴更新 Cookie", cookiesIn, { hint: "留空保持现有 Cookie 不变；会自动识别 JSON / Netscape / Header 格式" }),
      cookieKeys.length
        ? el(
            "label",
            { class: "switch-inline xs" },
            clearCookiesChk,
            el("span", null, "清空当前已保存的全部 Cookie")
          )
        : null,
      el(
        "div",
        { class: "form-grid-2" },
        field("用户名 (username)", usernameIn),
        field("用户 ID (user-id)", userIdIn)
      ),
      el(
        "div",
        { class: "form-grid-2" },
        el(
          "div",
          { class: "field" },
          el("label", null, "密码 (password)"),
          passwordIn,
          info.has_password ? el("label", { class: "switch-inline xs" }, clearPasswordChk, el("span", null, "清空已保存密码")) : null
        ),
        el(
          "div",
          { class: "field" },
          el("label", null, "API Key (api-key)"),
          apiKeyIn,
          info.has_api_key ? el("label", { class: "switch-inline xs" }, clearApiKeyChk, el("span", null, "清空已保存 API Key")) : null
        )
      ),
      el(
        "div",
        { class: "form-grid-2" },
        field("browser (cookies-from-browser)", browserIn),
        field("User-Agent", uaIn)
      )
    ),
    el(
      "section",
      { class: "fl-card stack" },
      cardHead("抽取规则与 ExifTool 后处理", {
        iconName: "settings",
        subtitle: "站点级 skip、文件名模板与元数据写入策略",
      }),
      el(
        "div",
        { class: "form-grid-2" },
        field("站点 Skip 覆盖", skipIn, { hint: `留空继承全局默认（${defaultSkip}）` }),
        field("站点文件名模板 (filename)", filenameIn)
      ),
      el(
        "div",
        { class: "subsection" },
        el(
          "div",
          { class: "subsection-head" },
          el("label", { class: "switch-inline" }, ppEnabled, el("strong", { class: "sm" }, "为该站点默认启用 ExifTool 后处理")),
          el("span", { class: "fl-badge neutral" }, "仅影响后处理模式为继承的任务")
        ),
        field("后处理方式", ppModeSel),
        ppBuiltinBox,
        ppCustomBox,
        ppPreviewCmd
      )
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
              title: "删除站点自定义配置",
              message: `确定清空并移除站点「${site}」在全局配置文件中的独立配置段吗？`,
              okText: "删除配置",
              danger: true,
            });
            if (!ok) return;
            try {
              await api.del(`/api/config/site/${encodeURIComponent(site)}`);
              toast(`已删除站点「${site}」配置段`);
              await ctx?.refreshHeader?.();
              navigate("#sites");
            } catch (err) {
              toast(`删除失败：${err.message}`, "danger");
            }
          },
        },
        icon("trash", 14),
        "删除配置"
      ),
      saveBtn
    )
  );

  const probeSection = el(
    "section",
    { class: "fl-card stack" },
    cardHead("在线连通性与元数据探测 (-K)", {
      iconName: "link",
      subtitle: "调用 gallery-dl -K 验证 URL 解析与登录态",
    }),
    el("div", { class: "input-with-btn" }, probeUrlIn, probeProxySel, probeBtn),
    probeCustomProxyIn,
    probeResultWrap
  );

  const domains = (healthItem.domains || SITE_DOMAINS[site] || []).join(", ");
  const taskIds = Array.isArray(healthItem.task_ids) ? healthItem.task_ids : [];
  const taskNames = Array.isArray(healthItem.task_names) ? healthItem.task_names : [];
  const statusCard = el(
    "section",
    { class: "fl-card stack sm-gap" },
    cardHead("站点状态", { iconName: "shield" }),
    metaList([
      { label: "健康状态", node: healthBadge(healthItem.health || "unknown") },
      { label: "配置状态", node: healthItem.configured ? el("span", { class: "status-pill ok" }, "已配置") : el("span", { class: "status-pill neutral" }, "未配置") },
      { label: "Cookie 数量", value: `${healthItem.cookie_count ?? cookieKeys.length} 项` },
      { label: "关联任务", value: taskIds.length ? `${taskIds.length} 个` : "暂无" },
      { label: "最近运行", value: healthItem.last_run_at ? fmtTimeShort(healthItem.last_run_at) : "暂无记录" },
    ]),
    taskIds.length
      ? el(
          "div",
          { class: "row-actions xs-gap", style: { flexWrap: "wrap" } },
          ...taskIds.map((tid, idx) =>
            el("a", { class: "fl-badge info", href: `#task/${encodeURIComponent(tid)}` }, taskNames[idx] || `任务 #${tid}`)
          )
        )
      : null,
    healthItem.last_auth_error_summary
      ? infoBar({
          tone: "danger",
          title: "最近认证错误",
          body: healthItem.last_auth_error_summary,
          actions: healthItem.last_auth_error_run_id
            ? [el("a", { class: "fl-btn subtle xs", href: `#runs/${healthItem.last_auth_error_run_id}` }, `查看 Run #${healthItem.last_auth_error_run_id}`)]
            : [],
        })
      : null
  );

  const domainCard = el(
    "section",
    { class: "fl-card stack sm-gap" },
    cardHead("Extractor 信息", { iconName: "globe" }),
    metaList([
      { label: "Extractor", node: el("code", null, site) },
      { label: "域名", value: domains || "—" },
      { label: "后处理", node: info.postprocess_enabled ? el("span", { class: "status-pill ok" }, "已启用") : el("span", { class: "status-pill neutral" }, "继承默认") },
    ]),
    el("a", { class: "fl-btn sm full", href: "#sites" }, icon("arrow-left", 14), "返回站点列表")
  );

  container.replaceChildren(
    el(
      "div",
      { class: "page-body" },
      breadcrumb([{ label: "站点与凭据", href: "#sites" }, { label: SITE_LABELS[site] || site }]),
      pageHead({
        eyebrow: "Site configuration",
        title: [SITE_LABELS[site] || site, healthBadge(healthItem.health || "unknown")],
        subtitle: `${site}${domains ? ` · ${domains}` : ""}`,
        actions: [el("a", { class: "fl-btn sm", href: "#sites" }, icon("arrow-left", 14), "返回列表")],
      }),
      el(
        "div",
        { class: "detail-layout" },
        el("div", { class: "detail-main" }, twitterCard, form, probeSection),
        el("aside", { class: "detail-aside" }, statusCard, domainCard)
      )
    )
  );

  return () => {
    destroyed = true;
  };
}
