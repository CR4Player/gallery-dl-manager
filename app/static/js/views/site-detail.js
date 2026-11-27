import { api } from "../api.js";
import { el, toast, confirmModal, healthBadge, copyText, SITE_LABELS, SITE_DOMAINS, debounce } from "../util.js";
import { navigate } from "../router.js";

export async function renderSiteDetail(container, route, ctx) {
  const site = route.site;
  if (!site) {
    navigate("#sites");
    return;
  }

  const [siteInfo, overviewRes, healthRes, twitterSync] = await Promise.all([
    api.get(`/api/config/site/${encodeURIComponent(site)}`).catch(() => null),
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/sites/health").catch(() => null),
    site === "twitter" ? api.get("/api/twitter-sync/status").catch(() => null) : Promise.resolve(null),
  ]);

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
  const clearPasswordChk = el("input", { type: "checkbox" });
  const apiKeyIn = el("input", {
    type: "password",
    value: "",
    placeholder: info.has_api_key ? "已保存 API Key（留空保持不变）" : "API Key（可选）",
  });
  const clearApiKeyChk = el("input", { type: "checkbox" });
  const userIdIn = el("input", { type: "text", value: info.user_id || "", placeholder: "User ID（可选）" });
  const browserIn = el("input", { type: "text", value: info.browser || "", placeholder: "例如 firefox 或 chrome（可选）" });
  const uaIn = el("input", { type: "text", value: info.user_agent || "", placeholder: "自定义 User-Agent（可选）" });

  const cookiesIn = el("textarea", {
    rows: 4,
    placeholder: "粘贴任意格式的 Cookie（JSON 对象、EditThisCookie JSON 数组、Netscape cookies.txt 或 key=value; ...），留空保持现有已存 Cookie 不变",
  });
  const clearCookiesChk = el("input", { type: "checkbox" });

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
    el("div", { class: "field" }, el("label", null, "日期字段模板"), ppDateIn),
    el("div", { class: "field" }, el("label", null, "额外 ExifTool 参数"), ppExtraIn)
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
      ].filter(Boolean).join("\n");
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
  const probeProxySel = el(
    "select",
    null,
    el("option", { value: "inherit" }, globalProxy ? `全局代理 (${globalProxy})` : "直连（无全局代理）"),
    el("option", { value: "direct" }, "强制直连")
  );
  const probeOut = el("pre", { class: "cmd-preview hidden" }, "");
  const probeBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn sm",
      onClick: async () => {
        const u = probeUrlIn.value.trim();
        if (!u) {
          toast("请输入一个该站点的测试 URL", "danger");
          return;
        }
        probeBtn.disabled = true;
        probeBtn.textContent = "解析中…";
        probeOut.classList.remove("hidden");
        probeOut.textContent = "正在调用 gallery-dl -K 探测元信息与登录态…";
        try {
          const res = await api.post("/api/probe-metadata", {
            url: u,
            proxy_mode: probeProxySel.value,
          });
          probeOut.textContent = JSON.stringify(res, null, 2);
          if (res?.ok) toast("元数据探测完成");
          else toast(res?.error || "探测返回异常", "danger");
        } catch (err) {
          probeOut.textContent = `探测失败: ${err.message}`;
          toast(`探测失败：${err.message}`, "danger");
        } finally {
          probeBtn.disabled = false;
          probeBtn.textContent = "执行 -K 探测";
        }
      },
    },
    "执行 -K 探测"
  );

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

    twitterCard = el(
      "section",
      { class: "fl-card stack sm-gap" },
      el(
        "div",
        { class: "row-actions between" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "Twitter / X 永久红心同步与历史迁移"),
        el("span", { class: "fl-badge info" }, twitterSync?.token ? "同步已就绪" : "待生成")
      ),
      el(
        "div",
        { class: "row-actions between fl-sub-card" },
        el(
          "div",
          null,
          el("div", { class: "sm" }, "Sync Token: ", tokenDisplay),
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
            "复制 Token"
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                const res = await api.post("/api/twitter-sync/token/rotate", {});
                if (res?.token) {
                  tokenDisplay.textContent = res.token;
                  copyText(res.token, "已轮换并复制新 Sync Token");
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
            "下载油猴脚本 (.user.js)"
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                const res = await api.post("/api/twitter-sync/scan-disk", {});
                toast(`扫描完成：共扫描 ${res?.scanned_files ?? 0} 个文件，新增回填 ${res?.inserted ?? 0} 条`);
                countSummary.textContent = `总计 ${res?.count ?? 0} 条已去重 ID · Archive ${res?.sources?.archive_sqlite ?? 0} · 磁盘 ${res?.sources?.disk ?? 0} · like.js ${res?.sources?.archive_js ?? 0} · 浏览器 ${res?.sources?.browser ?? 0}`;
              },
            },
            "扫描磁盘目录"
          )
        )
      ),
      el(
        "div",
        { class: "field" },
        el("label", null, "导入 X 官方存档 like.js / 链接列表"),
        likeJsIn,
        el(
          "div",
          { class: "row-actions", style: { justifyContent: "flex-end" } },
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
            "导入 like.js 记录"
          )
        )
      )
    );
  }

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, "保存站点配置");
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
          await renderSiteDetail(container, route, ctx);
        } catch (err) {
          toast(`保存失败：${err.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    el(
      "section",
      { class: "fl-card stack sm-gap" },
      el("h2", { class: "fl-card-title", style: { margin: 0 } }, "Cookie 与站点认证凭据"),
      cookieKeys.length
        ? el(
            "div",
            { class: "fl-sub-card row-actions", style: { flexWrap: "wrap", gap: "0.35rem" } },
            el("span", { class: "muted xs" }, `当前已存储 ${cookieKeys.length} 个 Cookie 字段：`),
            ...cookieKeys.map((k) => el("span", { class: "fl-badge info" }, k))
          )
        : el("div", { class: "muted xs" }, "当前尚未保存站点 Cookie"),
      el("div", { class: "field" }, el("label", null, "粘贴更新 Cookie (自动识别 JSON / Netscape / Header)"), cookiesIn),
      el("label", { class: "switch-inline xs" }, clearCookiesChk, el("span", null, "清空当前已保存的全部 Cookie")),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "用户名 (username)"), usernameIn),
        el("div", { class: "field" }, el("label", null, "用户 ID (user-id)"), userIdIn)
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
        el("div", { class: "field" }, el("label", null, "browser (cookies-from-browser)"), browserIn),
        el("div", { class: "field" }, el("label", null, "User-Agent"), uaIn)
      )
    ),
    el(
      "section",
      { class: "fl-card stack sm-gap" },
      el("h2", { class: "fl-card-title", style: { margin: 0 } }, "抽取规则与 ExifTool 站点后处理"),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "站点 Skip 覆盖"), skipIn),
        el("div", { class: "field" }, el("label", null, "站点文件名模板 (filename)"), filenameIn)
      ),
      el(
        "div",
        { class: "fl-sub-card stack sm-gap" },
        el(
          "div",
          { class: "row-actions between" },
          el("label", { class: "switch-inline" }, ppEnabled, el("strong", { class: "sm" }, "为该站点默认启用 ExifTool 后处理")),
          el("span", { class: "fl-badge neutral" }, "仅影响后处理模式为继承的任务")
        ),
        el("div", { class: "field" }, el("label", null, "后处理方式"), ppModeSel),
        ppBuiltinBox,
        ppCustomBox,
        ppPreviewCmd
      ),
      el(
        "div",
        { class: "row-actions between" },
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
              await api.del(`/api/config/site/${encodeURIComponent(site)}`);
              toast(`已删除站点「${site}」配置段`);
              navigate("#sites");
            },
          },
          "删除此站点配置"
        ),
        saveBtn
      )
    )
  );

  const probeSection = el(
    "section",
    { class: "fl-card stack sm-gap" },
    el("h2", { class: "fl-card-title", style: { margin: 0 } }, "在线连通性与元数据探测 (-K)"),
    el("div", { class: "input-with-btn" }, probeUrlIn, probeProxySel, probeBtn),
    probeOut
  );

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
          el("a", { class: "fl-btn subtle sm", href: "#sites" }, "← 返回站点列表"),
          el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.3rem" } }, SITE_LABELS[site] || site),
          healthBadge(healthItem.health || "unknown")
        )
      ),
      twitterCard,
      form,
      probeSection
    )
  );
}
