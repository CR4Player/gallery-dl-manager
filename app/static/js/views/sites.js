import { api } from "../api.js";
import { el, healthBadge, toast, SITE_LABELS, SITE_DOMAINS, fmtTimeShort } from "../util.js";
import { navigate } from "../router.js";

export async function renderSites(container) {
  const [healthRes, overviewRes, syncRes] = await Promise.all([
    api.get("/api/sites/health").catch(() => null),
    api.get("/api/config/overview").catch(() => null),
    api.get("/api/twitter-sync/status").catch(() => null),
  ]);

  // Backend /api/sites/health returns { sites: [ { site, configured, domains, cookie_count, ... } ] }
  // and /api/config/overview returns { sites: [ { site, cookie_count, ... } ] } (arrays, never dicts!)
  const healthMap = {};
  const rawHealthList = Array.isArray(healthRes?.sites)
    ? healthRes.sites
    : Array.isArray(overviewRes?.sites)
      ? overviewRes.sites
      : [];

  for (const item of rawHealthList) {
    if (item && typeof item === "object" && typeof item.site === "string" && item.site) {
      healthMap[item.site] = item;
    }
  }

  const allKeys = new Set([
    ...Object.keys(healthMap),
    ...Object.keys(SITE_LABELS),
  ]);

  let searchQuery = "";
  let onlyConfigured = false;
  const gridEl = el("div", { class: "sites-grid" });

  function renderGrid() {
    gridEl.innerHTML = "";
    const rank = { error: 0, warn: 1, ok: 2, unknown: 3 };
    const entries = [...allKeys]
      .filter((key) => {
        const h = healthMap[key];
        const isConfigured = Boolean(h?.configured);
        if (onlyConfigured && !isConfigured) return false;
        if (searchQuery) {
          const domains = (h?.domains || SITE_DOMAINS[key] || []).join(" ");
          const label = SITE_LABELS[key] || "";
          if (!`${key} ${label} ${domains}`.toLowerCase().includes(searchQuery)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ha = healthMap[a] || {};
        const hb = healthMap[b] || {};
        const ra = rank[ha.health || "unknown"] ?? 9;
        const rb = rank[hb.health || "unknown"] ?? 9;
        if (ra !== rb) return ra - rb;
        const ca = ha.configured ? 1 : 0;
        const cb = hb.configured ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return a.localeCompare(b);
      });

    if (!entries.length) {
      gridEl.appendChild(el("div", { class: "fl-card empty-state" }, "没有匹配的站点配置"));
      return;
    }

    for (const key of entries) {
      const info = healthMap[key] || {};
      const health = info.health || "unknown";
      const domains = (info.domains || SITE_DOMAINS[key] || []).slice(0, 3).join(", ");
      const cookieCount = Number(info.cookie_count || 0);
      const authCount = Array.isArray(info.auth_fields) ? info.auth_fields.length : 0;
      const hasCreds = Boolean(info.has_credentials || cookieCount > 0 || authCount > 0);
      const taskCount = Array.isArray(info.task_ids) ? info.task_ids.length : 0;

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
            healthBadge(health, info.configured ? (health === "unknown" ? "已配置" : undefined) : "未配置")
          ),
          el("div", { class: "muted xs" }, domains || `extractor.${key}`),
          el(
            "div",
            { class: "row-actions xs-gap", style: { flexWrap: "wrap" } },
            cookieCount > 0
              ? el("span", { class: "fl-badge info" }, `${cookieCount} 项 Cookie`)
              : hasCreds
                ? el("span", { class: "fl-badge info" }, "已配账密/Key")
                : el("span", { class: "fl-badge neutral" }, "无独立凭据"),
            info.postprocess_enabled ? el("span", { class: "fl-badge ok" }, "ExifTool 开启") : null,
            taskCount > 0 ? el("span", { class: "fl-badge neutral" }, `${taskCount} 个关联任务`) : null,
            info.skip ? el("span", { class: "fl-badge neutral" }, `Skip: ${info.skip}`) : null
          ),
          info.last_auth_error_summary
            ? el("div", { class: "fl-badge err", style: { alignSelf: "flex-start" } }, info.last_auth_error_summary)
            : info.last_run_at
              ? el("div", { class: "muted xs" }, `最近运行：${fmtTimeShort(info.last_run_at)}`)
              : null,
          el(
            "div",
            { class: "row-actions", style: { marginTop: "auto", paddingTop: "0.25rem", justifyContent: "flex-end" } },
            el(
              "a",
              { class: "fl-btn sm", href: `#site/${encodeURIComponent(key)}` },
              info.configured ? "编辑站点配置 →" : "初始化配置 →"
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
          el("strong", { class: "sm" }, "Twitter / X 永久红心历史同步服务"),
          el(
            "div",
            { class: "xs muted" },
            syncRes.token
              ? `同步令牌已就绪 · 已归档 ${syncRes.count ?? 0} 条推文 ID（Archive ${syncRes.sources?.archive_sqlite ?? 0} / 磁盘 ${syncRes.sources?.disk ?? 0} / like.js ${syncRes.sources?.archive_js ?? 0} / 浏览器 ${syncRes.sources?.browser ?? 0}）`
              : "进入 Twitter 站点配置可获取同步令牌与一键油猴脚本"
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
          el("div", { class: "muted xs" }, "管理各站 Cookie、账号秘钥、Skip 覆盖与 ExifTool 后处理规则")
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
          placeholder: "搜索站点名称或域名 (如 x.com, fanbox, patreon, pixiv)…",
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
          el("span", null, "仅显示已有配置的站点")
        )
      ),
      gridEl
    )
  );
}
