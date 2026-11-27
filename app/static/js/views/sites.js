import { api } from "../api.js";
import { el, healthBadge, toast, positionPopoverFallback, SITE_LABELS, SITE_DOMAINS, fmtTimeShort } from "../util.js";
import { navigate } from "../router.js";
import { pageHead, infoBar, emptyState } from "../ui.js";
import { icon } from "../icons.js";

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

  const allKeys = new Set([...Object.keys(healthMap), ...Object.keys(SITE_LABELS)]);

  let searchQuery = "";
  let onlyConfigured = false;
  const gridEl = el("div", { class: "sites-grid" });
  const countEl = el("span", { class: "muted xs", style: { marginInlineStart: "auto", whiteSpace: "nowrap" } });

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

    const configuredCount = entries.filter((k) => healthMap[k]?.configured).length;
    countEl.textContent = `${entries.length} 个站点 · ${configuredCount} 个已配置`;

    if (!entries.length) {
      gridEl.appendChild(
        el(
          "div",
          { class: "fl-card", style: { gridColumn: "1 / -1" } },
          emptyState("调整关键字或关闭「仅显示已配置」后重试", "globe", "没有匹配的站点")
        )
      );
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
      const label = SITE_LABELS[key] || key;
      const initial = (label || key).trim().charAt(0).toUpperCase() || "?";

      gridEl.appendChild(
        el(
          "a",
          { class: "site-card", href: `#site/${encodeURIComponent(key)}` },
          el(
            "div",
            { class: "site-card-top" },
            el("span", { class: `site-icon ${health === "error" ? "error" : health === "warn" ? "warn" : health === "ok" ? "ok" : ""}`.trim() }, initial),
            el(
              "div",
              { class: "stack xs-gap", style: { minWidth: 0, flex: 1 } },
              el(
                "div",
                { class: "site-card-title" },
                el("span", { class: `health-dot ${health}` }),
                el("span", { class: "site-name" }, label)
              ),
              el("div", { class: "site-domain", title: domains || `extractor.${key}` }, domains || `extractor.${key}`)
            ),
            healthBadge(health, info.configured ? (health === "unknown" ? "已配置" : undefined) : "未配置")
          ),
          el(
            "div",
            { class: "site-meta" },
            cookieCount > 0
              ? el("span", { class: "fl-badge info" }, `${cookieCount} 项 Cookie`)
              : hasCreds
                ? el("span", { class: "fl-badge info" }, "已配账密 / Key")
                : el("span", { class: "fl-badge neutral" }, "无独立凭据"),
            info.postprocess_enabled ? el("span", { class: "fl-badge ok" }, "ExifTool 开启") : null,
            taskCount > 0 ? el("span", { class: "fl-badge" }, `${taskCount} 个关联任务`) : null,
            info.skip ? el("span", { class: "fl-badge neutral", title: `Skip: ${info.skip}` }, `Skip: ${info.skip}`) : null
          ),
          el(
            "div",
            { class: "site-card-foot" },
            info.last_auth_error_summary
              ? el("span", { class: "text-danger truncate", title: info.last_auth_error_summary }, info.last_auth_error_summary)
              : el(
                  "span",
                  { class: "truncate" },
                  info.last_run_at ? `最近运行：${fmtTimeShort(info.last_run_at)}` : "尚未产生运行记录"
                ),
            el("span", { class: "site-open" }, info.configured ? "编辑配置" : "初始化配置", icon("chevron-right", 13))
          )
        )
      );
    }
  }

  const addSiteBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn accent sm",
      popovertarget: "add-site-popover",
      style: { anchorName: "--gdl-add-site" },
    },
    icon("plus", 14),
    el("span", null, "添加自定义站点")
  );

  const addSiteInput = el("input", {
    type: "text",
    placeholder: "如 mastodon、kemono…",
    "aria-label": "自定义站点 extractor 名称",
    autocomplete: "off",
  });

  const addSitePopover = el(
    "div",
    {
      id: "add-site-popover",
      popover: "auto",
      class: "fl-flyout site-add-popover",
    },
    el(
      "form",
      {
        class: "stack sm-gap",
        onSubmit: (e) => {
          e.preventDefault();
          const name = addSiteInput.value.trim().toLowerCase();
          if (!name) {
            toast("请输入 gallery-dl extractor 名称", "danger");
            addSiteInput.focus();
            return;
          }
          if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
            toast("extractor 名称仅支持字母、数字、点、下划线和连字符", "danger");
            addSiteInput.focus();
            return;
          }
          addSiteInput.value = "";
          addSitePopover.hidePopover?.();
          navigate(`#site/${encodeURIComponent(name)}`);
        },
      },
      el(
        "div",
        { class: "stack xs-gap" },
        el("div", { class: "site-add-popover-title" }, "打开 / 新建自定义站点"),
        el("span", { class: "hint" }, "输入 gallery-dl 支持的 extractor 名称")
      ),
      addSiteInput,
      el(
        "div",
        { class: "site-add-popover-foot" },
        el(
          "button",
          {
            type: "button",
            class: "fl-btn sm",
            onClick: () => addSitePopover.hidePopover?.(),
          },
          el("span", null, "取消")
        ),
        el("button", { type: "submit", class: "fl-btn accent sm" }, el("span", null, "打开配置"))
      )
    )
  );

  addSitePopover.addEventListener("toggle", (e) => {
    if (e.newState === "open") {
      positionPopoverFallback(addSitePopover, addSiteBtn);
      requestAnimationFrame(() => {
        addSiteInput.focus();
        addSiteInput.select();
      });
    }
  });

  const twitterCard = syncRes
    ? infoBar({
        tone: "info",
        iconName: "activity",
        title: "Twitter / X 永久红心历史同步服务",
        body: syncRes.token
          ? `同步令牌已就绪 · 已归档 ${syncRes.count ?? 0} 条推文 ID（Archive ${syncRes.sources?.archive_sqlite ?? 0} / 磁盘 ${syncRes.sources?.disk ?? 0} / like.js ${syncRes.sources?.archive_js ?? 0} / 浏览器 ${syncRes.sources?.browser ?? 0}）`
          : "进入 Twitter 站点配置可获取同步令牌与一键油猴脚本",
        actions: [el("a", { class: "fl-btn sm", href: "#site/twitter" }, "管理同步", icon("chevron-right", 13))],
      })
    : null;

  renderGrid();

  container.replaceChildren(
    el(
      "div",
      { class: "page-body" },
      pageHead({
        eyebrow: "Sites & credentials",
        title: "站点与凭据",
        subtitle: "管理各站 Cookie、账号秘钥、Skip 覆盖与 ExifTool 后处理规则",
        actions: [addSiteBtn, addSitePopover],
      }),
      twitterCard,
      el(
        "div",
        { class: "fl-card row-actions", style: { padding: "10px 12px" } },
        el(
          "div",
          { class: "search-box" },
          icon("search", 15),
          el("input", {
            type: "search",
            placeholder: "搜索站点名称或域名，如 x.com、fanbox、patreon、pixiv…",
            "aria-label": "搜索站点",
            onInput: (e) => {
              searchQuery = e.target.value.trim().toLowerCase();
              renderGrid();
            },
          })
        ),
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
          el("span", null, "仅显示已配置的站点")
        ),
        countEl
      ),
      gridEl
    )
  );
}
