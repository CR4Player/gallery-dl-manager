import { api } from "../api.js";
import { el, healthBadge, toast, SITE_LABELS, SITE_DOMAINS } from "../util.js";
import { navigate } from "../router.js";

export async function renderSites(container) {
  const [overview, healthRes, syncRes] = await Promise.all([
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/sites/health").catch(() => null),
    api.get("/api/twitter-sync/status").catch(() => null),
  ]);

  const configuredSites = overview?.sites || overview?.extractors || {};
  const healthMap = {};
  const hList = healthRes?.sites || healthRes?.items || [];
  if (Array.isArray(hList)) {
    for (const item of hList) {
      if (item.site) healthMap[item.site] = item;
    }
  } else if (healthRes && typeof healthRes === "object") {
    Object.assign(healthMap, healthRes);
  }

  const allKeys = new Set([
    ...Object.keys(SITE_LABELS),
    ...Object.keys(configuredSites),
    ...Object.keys(healthMap),
  ]);

  let searchQuery = "";
  let onlyConfigured = false;

  const gridEl = el("div", { class: "sites-grid" });

  function renderGrid() {
    gridEl.innerHTML = "";
    const entries = [...allKeys]
      .filter((key) => {
        const cfg = configuredSites[key];
        const isConfigured = Boolean(cfg && Object.keys(cfg).length);
        if (onlyConfigured && !isConfigured) return false;
        if (searchQuery) {
          const domains = (SITE_DOMAINS[key] || []).join(" ");
          const label = SITE_LABELS[key] || "";
          if (!`${key} ${label} ${domains}`.toLowerCase().includes(searchQuery)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ca = configuredSites[a] ? 1 : 0;
        const cb = configuredSites[b] ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return a.localeCompare(b);
      });

    if (!entries.length) {
      gridEl.appendChild(el("div", { class: "fl-card empty-state" }, "没有匹配的站点配置"));
      return;
    }

    for (const key of entries) {
      const cfg = configuredSites[key] || {};
      const h = healthMap[key] || {};
      const health = h.health || (Object.keys(cfg).length ? "ok" : "unknown");
      const domains = (SITE_DOMAINS[key] || []).slice(0, 3).join(", ");
      const hasCookies = Boolean(cfg.cookies || cfg["cookies-from-browser"] || cfg.username || cfg.token || cfg["refresh-token"]);

      gridEl.appendChild(
        el(
          "article",
          { class: "fl-card stack sm-gap" },
          el(
            "div",
            { class: "row-actions between" },
            el(
              "div",
              { class: "row-actions xs-gap" },
              el("span", { class: `health-dot ${health}` }),
              el("strong", { style: { fontSize: "0.96rem" } }, SITE_LABELS[key] || key)
            ),
            healthBadge(health, h.label || undefined)
          ),
          el("div", { class: "muted xs" }, domains || `extractor.${key}`),
          el(
            "div",
            { class: "row-actions xs-gap", style: { flexWrap: "wrap" } },
            hasCookies ? el("span", { class: "fl-badge info" }, "已配凭据") : el("span", { class: "fl-badge neutral" }, "无独立凭据"),
            cfg.proxy !== undefined ? el("span", { class: "fl-badge neutral" }, "独立代理") : null,
            cfg.postprocessors ? el("span", { class: "fl-badge neutral" }, "后处理覆盖") : null
          ),
          h.message ? el("div", { class: "muted xs" }, h.message) : null,
          el(
            "div",
            { class: "row-actions", style: { marginTop: "auto", paddingTop: "0.25rem", justifyContent: "flex-end" } },
            el(
              "a",
              { class: "fl-btn sm", href: `#site/${encodeURIComponent(key)}` },
              Object.keys(cfg).length ? "编辑站点配置 →" : "初始化配置 →"
            )
          )
        )
      );
    }
  }

  const customSiteInput = el("input", {
    type: "text",
    placeholder: "输入自定义 extractor 名，如 bluesky / mastodon",
    style: { minInlineSize: "220px" },
  });

  const twitterCard = syncRes
    ? el(
        "div",
        { class: "fl-infobar info", style: { justifyContent: "space-between" } },
        el(
          "div",
          null,
          el("strong", { class: "sm" }, "Twitter / X Cookie 无感同步服务"),
          el(
            "div",
            { class: "xs muted" },
            syncRes.token_configured
              ? `已就绪 · 最近同步: ${syncRes.last_sync_at || "尚未上报"}`
              : "尚未生成同步令牌，进入 Twitter 站点详情或设置页可一键生成并安装油猴脚本"
          )
        ),
        el("a", { class: "fl-btn sm", href: "#site/twitter" }, "管理 Twitter 同步 →")
      )
    : null;

  renderGrid();

  container.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row-actions between" },
        el(
          "div",
          null,
          el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.35rem" } }, "站点与凭据"),
          el("div", { class: "muted xs" }, "管理各站 Cookie、OAuth Token、独立代理、限速与后处理覆盖规则")
        ),
        el(
          "div",
          { class: "row-actions" },
          customSiteInput,
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: () => {
                const name = customSiteInput.value.trim().toLowerCase();
                if (!name) {
                  toast("请输入 gallery-dl extractor 名称", "danger");
                  return;
                }
                navigate(`#site/${encodeURIComponent(name)}`);
              },
            },
            "打开/新建站点"
          )
        )
      ),
      twitterCard,
      el(
        "div",
        { class: "fl-card row-actions between" },
        el("input", {
          type: "search",
          style: { flex: 1, minInlineSize: "200px" },
          placeholder: "搜索站点名称或域名 (如 x.com, pixiv, fanbox)…",
          onInput: (e) => {
            searchQuery = e.target.value.trim().toLowerCase();
            renderGrid();
          },
        }),
        el(
          "label",
          { class: "switch-inline" },
          el("input", {
            type: "checkbox",
            role: "switch",
            switch: true,
            onChange: (e) => {
              onlyConfigured = e.target.checked;
              renderGrid();
            },
          }),
          el("span", null, "仅显示已有覆盖配置的站点")
        )
      ),
      gridEl
    )
  );
}
