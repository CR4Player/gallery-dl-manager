import { api } from "../api.js";
import { el, toast, confirmModal, healthBadge, copyText, SITE_LABELS, SITE_DOMAINS } from "../util.js";
import { navigate } from "../router.js";
import { createOverrideField } from "../components/override-field.js";

export async function renderSiteDetail(container, route, ctx) {
  const site = route.site;
  if (!site) {
    navigate("#sites");
    return;
  }

  const [siteRes, overviewRes, healthRes, twitterSync] = await Promise.all([
    api.get(`/api/config/site/${encodeURIComponent(site)}`).catch(() => null),
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/sites/health").catch(() => null),
    site === "twitter" ? api.get("/api/twitter-sync/status").catch(() => null) : Promise.resolve(null),
  ]);

  const globalCfg = overviewRes?.global_config || overviewRes?.settings || {};
  const cfg = siteRes?.config || overviewRes?.sites?.[site] || {};
  const healthMap = Array.isArray(healthRes?.sites)
    ? Object.fromEntries(healthRes.sites.map((x) => [x.site, x]))
    : healthRes || {};
  const hInfo = healthMap[site] || {};

  // Known fields managed by dedicated inputs; unknown keys stay in raw extra JSON
  const MANAGED_KEYS = new Set([
    "cookies",
    "username",
    "password",
    "refresh-token",
    "api-key",
    "proxy",
    "skip",
    "sleep-request",
    "directory",
    "filename",
    "archive",
  ]);
  const extraObj = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!MANAGED_KEYS.has(k)) extraObj[k] = v;
  }

  const cookiesIn = el("input", {
    type: "text",
    value: typeof cfg.cookies === "string" ? cfg.cookies : "",
    placeholder: `/cookies/${site}.txt`,
  });
  const cookiePasteIn = el("textarea", {
    rows: 3,
    placeholder: "可选：直接粘贴 Netscape 格式 cookies.txt 内容，保存时自动写入凭据文件",
  });
  const usernameIn = el("input", {
    type: "text",
    value: cfg.username || "",
    placeholder: "账号/用户名（可选）",
  });
  const passwordIn = el("input", {
    type: "password",
    value: "",
    placeholder: cfg.password ? "已保存脱敏口令（留空保持不变）" : "密码（可选）",
  });
  const tokenIn = el("input", {
    type: "password",
    value: "",
    placeholder: cfg["refresh-token"] || cfg["api-key"] ? "已保存 Token（留空保持不变）" : "Refresh Token / API Key（可选）",
  });

  const proxyOv = createOverrideField({
    label: "站点独立代理",
    value: cfg.proxy ?? null,
    type: "text",
    placeholder: "http://127.0.0.1:7890 或 direct",
    defaultCustomValue: globalCfg.proxy || "",
    inheritedText: globalCfg.proxy || "未配置全局代理（直连）",
    inheritedSource: "全局设置",
  });

  const skipOv = createOverrideField({
    label: "站点 Skip 策略",
    value: cfg.skip ?? null,
    type: "text",
    placeholder: "abort:10",
    defaultCustomValue: "abort:10",
    inheritedText: globalCfg.skip || "abort:7",
    inheritedSource: "全局设置",
  });

  const sleepOv = createOverrideField({
    label: "请求间隔 (sleep-request 秒)",
    value: cfg["sleep-request"] ?? null,
    type: "number",
    min: 0,
    step: "0.5",
    defaultCustomValue: 2,
    inheritedText: globalCfg["sleep-request"] ? `${globalCfg["sleep-request"]} s` : "gallery-dl 默认",
    inheritedSource: "全局设置",
  });

  const dirIn = el("input", {
    type: "text",
    value: Array.isArray(cfg.directory) ? JSON.stringify(cfg.directory) : cfg.directory || "",
    placeholder: '例如 ["{category}", "{author[name]}"]',
  });
  const filenameIn = el("input", {
    type: "text",
    value: cfg.filename || "",
    placeholder: "例如 {date:%Y-%m-%d}_{id}_{num}.{extension}",
  });
  const extraJsonIn = el("textarea", {
    rows: 5,
    value: Object.keys(extraObj).length ? JSON.stringify(extraObj, null, 2) : "",
    placeholder: '{\n  "retweets": false,\n  "replies": false\n}',
    style: { fontFamily: "var(--fl-mono)", fontSize: "0.78rem" },
  });

  // Probe (-K) card
  const sampleDomain = (SITE_DOMAINS[site] || [`${site}.com`])[0];
  const probeUrlIn = el("input", {
    type: "url",
    placeholder: `https://${sampleDomain}/...`,
  });
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
          const customProxy = proxyOv.getValue();
          const res = await api.post("/api/probe-metadata", {
            url: u,
            proxy_mode: customProxy === "direct" ? "direct" : customProxy ? "custom" : "inherit",
            proxy_url: customProxy && customProxy !== "direct" ? customProxy : "",
          });
          probeOut.textContent = JSON.stringify(res, null, 2);
          toast("元数据探测完成");
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
    const tokenDisplay = el("code", null, twitterSync?.token_preview || "未生成");
    const likeJsIn = el("textarea", {
      rows: 3,
      placeholder: "粘贴从浏览器导出的 like.js 文件内容或链接片段…",
    });

    twitterCard = el(
      "section",
      { class: "fl-card stack sm-gap" },
      el(
        "div",
        { class: "row-actions between" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "Twitter / X 无感 Cookie 同步与历史迁移"),
        el("span", { class: "fl-badge info" }, twitterSync?.token_configured ? "同步已启用" : "待初始化")
      ),
      el(
        "div",
        { class: "row-actions between fl-sub-card" },
        el(
          "div",
          null,
          el("div", { class: "sm" }, "同步凭证: ", tokenDisplay),
          el("div", { class: "muted xs" }, `最近同步: ${twitterSync?.last_sync_at || "尚未触发"}`)
        ),
        el(
          "div",
          { class: "row-actions" },
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                const res = await api.post("/api/twitter-sync/token/rotate", {});
                tokenDisplay.textContent = res?.token || res?.token_preview || "已轮换";
                if (res?.token) copyText(res.token, "已轮换并复制新 Sync Token");
                else toast("已轮换 Twitter 同步 Token");
              },
            },
            "生成/轮换 Token"
          ),
          el(
            "a",
            {
              class: "fl-btn accent sm",
              href: "/api/twitter-sync/userscript.user.js",
              target: "_blank",
              rel: "noopener",
            },
            "安装油猴脚本 (.user.js)"
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                const res = await api.post("/api/twitter-sync/scan-disk", {});
                toast(res?.message || `磁盘扫描完成，回填 ${res?.inserted ?? 0} 条记录`);
              },
            },
            "扫描磁盘回填 Archive"
          )
        )
      ),
      el(
        "div",
        { class: "field" },
        el("label", null, "导入旧版 like.js 点赞历史归档"),
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
                const res = await api.post("/api/twitter-sync/import-like-js", { content });
                toast(res?.message || `成功导入 ${res?.imported ?? 0} 条历史记录`);
                likeJsIn.value = "";
              },
            },
            "导入 like.js 记录"
          )
        )
      )
    );
  }

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, "保存站点配置");

  const form = el(
    "form",
    {
      class: "stack",
      onSubmit: async (e) => {
        e.preventDefault();
        let extra = {};
        if (extraJsonIn.value.trim()) {
          try {
            extra = JSON.parse(extraJsonIn.value);
          } catch (err) {
            toast(`扩展 JSON 格式错误：${err.message}`, "danger");
            extraJsonIn.focus();
            return;
          }
        }
        const nextCfg = { ...extra };
        if (cookiesIn.value.trim()) nextCfg.cookies = cookiesIn.value.trim();
        if (usernameIn.value.trim()) nextCfg.username = usernameIn.value.trim();
        if (passwordIn.value) nextCfg.password = passwordIn.value;
        else if (cfg.password) nextCfg.password = cfg.password;

        if (tokenIn.value) nextCfg["refresh-token"] = tokenIn.value;
        else if (cfg["refresh-token"]) nextCfg["refresh-token"] = cfg["refresh-token"];

        const pVal = proxyOv.getValue();
        if (pVal !== null && pVal !== "") nextCfg.proxy = pVal;
        const sVal = skipOv.getValue();
        if (sVal !== null && sVal !== "") nextCfg.skip = sVal;
        const slVal = sleepOv.getValue();
        if (slVal !== null && slVal !== "") nextCfg["sleep-request"] = Number(slVal);

        if (dirIn.value.trim()) {
          const d = dirIn.value.trim();
          if (d.startsWith("[")) {
            try {
              nextCfg.directory = JSON.parse(d);
            } catch {
              nextCfg.directory = d;
            }
          } else {
            nextCfg.directory = d;
          }
        }
        if (filenameIn.value.trim()) nextCfg.filename = filenameIn.value.trim();

        saveBtn.disabled = true;
        try {
          await api.put(`/api/config/site/${encodeURIComponent(site)}`, {
            config: nextCfg,
            cookie_content: cookiePasteIn.value.trim() || undefined,
          });
          toast(`已保存「${SITE_LABELS[site] || site}」配置`);
          cookiePasteIn.value = "";
          passwordIn.value = "";
          tokenIn.value = "";
          await ctx?.refreshHeader?.();
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
      el("h2", { class: "fl-card-title", style: { margin: 0 } }, "认证凭据与 Cookie 文件"),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "Cookie 文件路径 (Netscape cookies.txt)"), cookiesIn),
        el("div", { class: "field" }, el("label", null, "用户名 / 账号"), usernameIn)
      ),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "密码 / Secret"), passwordIn),
        el("div", { class: "field" }, el("label", null, "Refresh Token / API Key"), tokenIn)
      ),
      el("div", { class: "field" }, el("label", null, "快速粘贴更新 Netscape cookies.txt 内容"), cookiePasteIn)
    ),
    el(
      "section",
      { class: "fl-card stack sm-gap" },
      el("h2", { class: "fl-card-title", style: { margin: 0 } }, "网络、节流与路径覆盖"),
      el("div", { class: "form-grid-3" }, proxyOv.el, skipOv.el, sleepOv.el),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "目录结构模板 (directory)"), dirIn),
        el("div", { class: "field" }, el("label", null, "文件名模板 (filename)"), filenameIn)
      ),
      el(
        "details",
        { class: "fl-expander" },
        el("summary", { class: "fl-expander-head" }, "高级站点参数 (JSON 扩展字段)"),
        el("div", { class: "fl-expander-body field" }, extraJsonIn)
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
                title: "恢复站点默认配置",
                message: `确定清除站点「${site}」的所有自定义覆盖配置吗？`,
                okText: "清除覆盖",
                danger: true,
              });
              if (!ok) return;
              await api.del(`/api/config/site/${encodeURIComponent(site)}`);
              toast(`已清除站点「${site}」覆盖配置`);
              navigate("#sites");
            },
          },
          "恢复默认配置"
        ),
        saveBtn
      )
    )
  );

  const probeSection = el(
    "section",
    { class: "fl-card stack sm-gap" },
    el("h2", { class: "fl-card-title", style: { margin: 0 } }, "在线连通性与元数据探测 (-K)"),
    el(
      "div",
      { class: "input-with-btn" },
      probeUrlIn,
      probeBtn
    ),
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
          healthBadge(hInfo.health || "unknown", hInfo.message || undefined)
        )
      ),
      twitterCard,
      form,
      probeSection
    )
  );
}
