import { api } from "../api.js";
import { el, toast, confirmModal, fmtTimeShort, fmtBytes, copyText } from "../util.js";
import { pageHead, cardHead, field, infoBar, emptyState } from "../ui.js";
import { icon } from "../icons.js";

const TABS = [
  { id: "general", label: "全局与代理", icon: "settings" },
  { id: "auth", label: "安全与口令", icon: "lock" },
  { id: "notifications", label: "告警通知", icon: "bell" },
  { id: "cookies", label: "列表与同步", icon: "folder" },
  { id: "raw", label: "原始 JSON 与快照", icon: "file-text" },
];

function settingRow(title, description, control) {
  return el(
    "div",
    { class: "setting-row" },
    el(
      "div",
      { class: "setting-text" },
      el("strong", null, title),
      description ? el("span", null, description) : null
    ),
    el("div", { class: "setting-control" }, control)
  );
}

export async function renderSettings(container, route, ctx) {
  let destroyed = false;
  const activeTab = TABS.some((t) => t.id === route.tab) ? route.tab : "general";

  const navEl = el(
    "nav",
    { class: "settings-nav", "aria-label": "设置分类" },
    ...TABS.map((t) =>
      el(
        "a",
        {
          class: "settings-nav-link",
          href: `#settings/${t.id}`,
          "aria-current": t.id === activeTab ? "page" : undefined,
        },
        icon(t.icon, 16),
        el("span", null, t.label)
      )
    )
  );

  const bodyEl = el(
    "div",
    { class: "settings-content" },
    el(
      "div",
      { class: "fl-infobar" },
      el("span", { class: "infobar-icon" }, el("span", { class: "spinner" })),
      el("div", { class: "infobar-body" }, "正在载入设置项…")
    )
  );

  container.replaceChildren(
    el(
      "div",
      { class: "page-body" },
      pageHead({
        eyebrow: "Settings",
        title: "系统设置",
        subtitle: "管理全局下载策略、控制台密码、多通道告警通知、NAS 列表及原始配置快照",
      }),
      el("div", { class: "settings-layout" }, navEl, bodyEl)
    )
  );

  requestAnimationFrame(() => {
    if (!destroyed && window.matchMedia("(max-width: 900px)").matches) {
      navEl.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    }
  });

  const isStale = () => destroyed;
  if (activeTab === "general") {
    await renderGeneralTab(bodyEl, ctx, isStale);
  } else if (activeTab === "auth") {
    await renderAuthTab(bodyEl, isStale);
  } else if (activeTab === "notifications") {
    await renderNotificationsTab(bodyEl, isStale);
  } else if (activeTab === "cookies") {
    await renderCookiesTab(bodyEl, isStale);
  } else if (activeTab === "raw") {
    await renderRawTab(bodyEl, ctx, isStale);
  }

  return () => {
    destroyed = true;
  };
}

async function renderGeneralTab(root, ctx, isStale = () => false) {
  const overview = await api.get("/api/config/overview");
  if (isStale()) return;
  const settings = overview?.settings || {};
  const downloader = overview?.downloader || {};

  const proxyIn = el("input", {
    type: "text",
    value: settings.global_proxy || "",
    placeholder: "http://host.docker.internal:7890",
  });
  const skipIn = el("input", { type: "text", value: overview?.default_skip || "abort:7", placeholder: "abort:7" });
  const concIn = el("input", { type: "number", min: "1", max: "3", value: settings.max_concurrency ?? 1 });
  const retDaysIn = el("input", { type: "number", min: "1", max: "365", value: settings.log_retention_days ?? 30 });
  const retriesIn = el("input", { type: "number", min: "0", max: "20", value: downloader.retries ?? 4 });
  const timeoutIn = el("input", { type: "number", min: "5", max: "300", step: "1", value: downloader.timeout ?? 30 });
  const ppSitesIn = el("input", {
    type: "text",
    value: Array.isArray(settings.postprocess_default_sites) ? settings.postprocess_default_sites.join(", ") : "twitter",
    placeholder: "例如 twitter, bluesky",
  });

  const proxyStatus = el("div", { class: "hint hidden" });

  const testProxyBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn sm",
      onClick: async () => {
        const p = proxyIn.value.trim();
        testProxyBtn.disabled = true;
        proxyStatus.classList.remove("hidden");
        proxyStatus.textContent = "正在测试连通性…";
        try {
          const res = await api.post("/api/config/proxy-test", { proxy_url: p });
          proxyStatus.textContent = res?.ok
            ? `连接成功（HTTP ${res.status}）${res.detail ? ` · ${res.detail}` : ""}`
            : `连接失败：${res?.detail || "不可达"}`;
          toast(res?.ok ? "代理连通性正常" : "代理连通性测试失败", res?.ok ? "info" : "danger");
        } catch (err) {
          proxyStatus.textContent = `测试失败：${err.message}`;
          toast(`代理测试失败：${err.message}`, "danger");
        } finally {
          testProxyBtn.disabled = false;
        }
      },
    },
    icon("zap", 14),
    "测试连通性"
  );

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, icon("save", 15), "保存全局配置");

  root.replaceChildren(
    el(
      "form",
      {
        class: "fl-card stack",
        onSubmit: async (e) => {
          e.preventDefault();
          saveBtn.disabled = true;
          try {
            const ppSites = ppSitesIn.value
              .split(/[,，\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            await api.put("/api/config/settings", {
              global_proxy: proxyIn.value.trim(),
              default_skip: skipIn.value.trim(),
              max_concurrency: Number(concIn.value || 1),
              log_retention_days: Number(retDaysIn.value || 30),
              retries: Number(retriesIn.value || 4),
              timeout: Number(timeoutIn.value || 30),
              postprocess_default_sites: ppSites,
            });
            toast("已保存全局设置并生成配置快照");
            await ctx?.refreshHeader?.();
          } catch (err) {
            toast(`保存失败：${err.message}`, "danger");
          } finally {
            saveBtn.disabled = false;
          }
        },
      },
      cardHead("全局下载策略与网络代理", {
        iconName: "settings",
        subtitle: "这些默认值会被任务级、站点级配置按优先级覆盖",
      }),
      el(
        "div",
        { class: "stack xs-gap" },
        settingRow(
          "全局代理 URL",
          "支持 HTTP / HTTPS / SOCKS；留空表示直连。",
          el("div", { class: "input-with-btn" }, proxyIn, testProxyBtn)
        ),
        proxyStatus
      ),
      settingRow("默认 Skip 策略", "gallery-dl 遇到已存在文件时的行为。", skipIn),
      settingRow("最大并发下载数", "同时执行的运行数上限（1–3），保存后立即对新入队任务生效。", concIn),
      settingRow("运行日志保留天数", "超过此天数的历史运行日志会被清理。", retDaysIn),
      settingRow("网络重试次数", "单次请求失败后的重试上限。", retriesIn),
      settingRow("请求超时", "单位秒，过小可能导致大文件下载失败。", timeoutIn),
      settingRow("默认开启 ExifTool 的站点", "逗号分隔的站点名，例如 twitter, bluesky。", ppSitesIn),
      el("div", { class: "row-actions", style: { justifyContent: "flex-end" } }, saveBtn)
    )
  );
}

async function renderAuthTab(root, isStale = () => false) {
  const status = await api.get("/api/auth/status", { noAuthRedirect: true }).catch(() => ({ auth_disabled: true }));
  if (isStale()) return;
  if (status?.auth_disabled) {
    root.replaceChildren(
      el(
        "div",
        { class: "fl-card stack" },
        cardHead("Web 登录认证状态", { iconName: "lock" }),
        infoBar({
          tone: "warn",
          title: "登录认证已禁用",
          body: "当前容器通过环境变量禁用了登录认证（WEB_AUTH_DISABLED=true）。若控制台暴露在局域网 / 公网中，请务必关闭该选项。",
        })
      )
    );
    return;
  }

  const curIn = el("input", { type: "password", required: true, autocomplete: "current-password", "aria-invalid": "false" });
  const newIn = el("input", {
    type: "password",
    required: true,
    minlength: 6,
    autocomplete: "new-password",
    "aria-invalid": "false",
    placeholder: "至少 6 位",
  });
  const new2In = el("input", {
    type: "password",
    required: true,
    minlength: 6,
    autocomplete: "new-password",
    "aria-invalid": "false",
    placeholder: "再次输入新密码",
  });
  const submitBtn = el("button", { type: "submit", class: "fl-btn accent" }, icon("save", 15), "更新管理员密码");

  root.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "form",
        {
          class: "fl-card stack",
          onSubmit: async (e) => {
            e.preventDefault();
            if (!curIn.value || newIn.value.length < 6) {
              toast("请输入当前密码且新密码不少于 6 位", "danger");
              return;
            }
            if (newIn.value !== new2In.value) {
              toast("两次输入的新密码不一致", "danger");
              return;
            }
            submitBtn.disabled = true;
            try {
              await api.post("/api/auth/password", {
                current_password: curIn.value,
                new_password: newIn.value,
              });
              toast("管理员密码已修改");
              curIn.value = "";
              newIn.value = "";
              new2In.value = "";
            } catch (err) {
              toast(`修改失败：${err.message}`, "danger");
            } finally {
              submitBtn.disabled = false;
            }
          },
        },
        cardHead("修改管理员密码", {
          iconName: "lock",
          subtitle: "密码通过 HttpOnly Cookie 维持会话，修改后请使用新密码重新登录",
        }),
        field("当前密码", curIn),
        el("div", { class: "form-grid-2" }, field("新密码", newIn), field("确认新密码", new2In)),
        el(
          "div",
          { class: "row-actions between" },
          el(
            "button",
            {
              type: "button",
              class: "fl-btn danger sm",
              onClick: async () => {
                try {
                  await api.post("/api/auth/logout", {});
                  location.replace("/login");
                } catch (err) {
                  toast(`退出会话失败：${err.message}`, "danger");
                }
              },
            },
            icon("logout", 14),
            "退出当前会话"
          ),
          submitBtn
        )
      ),
      el(
        "div",
        { class: "fl-card stack sm-gap" },
        cardHead("会话说明", { iconName: "info" }),
        el(
          "div",
          { class: "muted sm" },
          "会话通过 HttpOnly Cookie 在本地维护。若忘记密码，可在容器内执行 ",
          el("code", null, "python3 -m app.main --reset-web-auth"),
          " 重置并重新获取一次性初始化口令。"
        )
      )
    )
  );
}

async function renderNotificationsTab(root, isStale = () => false) {
  const data = await api.get("/api/notifications");
  if (isStale()) return;
  // Backend schema puts telegram/feishu/bark/webhook as TOP-LEVEL keys inside data.config
  const cfg = data?.config || {};
  const logs = Array.isArray(data?.logs) ? data.logs : [];

  const notifyOnSet = new Set(Array.isArray(cfg.notify_on) ? cfg.notify_on : ["failed", "auth_error", "partial"]);
  const globalEnabled = el("input", { type: "checkbox", role: "switch", switch: true, checked: Boolean(cfg.enabled) });
  const cooldownIn = el("input", { type: "number", min: 0, value: cfg.cooldown_minutes ?? 60 });
  const recoverySwitch = el("input", { type: "checkbox", role: "switch", switch: true, checked: Boolean(cfg.notify_on_recovery) });
  const proxySwitch = el("input", { type: "checkbox", role: "switch", switch: true, checked: Boolean(cfg.use_proxy) });

  const chState = {
    telegram: {
      enabled: Boolean(cfg.telegram?.enabled),
      bot_token: cfg.telegram?.bot_token || "",
      chat_id: cfg.telegram?.chat_id || "",
      api_base: cfg.telegram?.api_base || "https://api.telegram.org",
    },
    feishu: {
      enabled: Boolean(cfg.feishu?.enabled),
      webhook_url: cfg.feishu?.webhook_url || "",
      secret: cfg.feishu?.secret || "",
    },
    bark: {
      enabled: Boolean(cfg.bark?.enabled),
      server_url: cfg.bark?.server_url || "https://api.day.app",
      device_key: cfg.bark?.device_key || "",
      group: cfg.bark?.group || "gallery-dl",
    },
    webhook: {
      enabled: Boolean(cfg.webhook?.enabled),
      url: cfg.webhook?.url || "",
      headers_json: cfg.webhook?.headers_json || "{}",
    },
  };

  function collectFullConfig() {
    return {
      enabled: globalEnabled.checked,
      notify_on: [...notifyOnSet],
      notify_on_recovery: recoverySwitch.checked,
      cooldown_minutes: Number(cooldownIn.value || 0),
      use_proxy: proxySwitch.checked,
      ...chState,
    };
  }

  function makeChannelCard(key, title, fieldsSpec) {
    const c = chState[key];
    const sw = el("input", {
      type: "checkbox",
      role: "switch",
      switch: true,
      checked: c.enabled,
      onChange: (e) => {
        c.enabled = e.target.checked;
      },
    });
    const testBtn = el(
      "button",
      {
        type: "button",
        class: "fl-btn sm",
        onClick: async () => {
          testBtn.disabled = true;
          try {
            const res = await api.post("/api/notifications/test", {
              channel: key,
              config: collectFullConfig(),
            });
            const detail = res?.results?.[0]?.detail || "";
            toast(res?.ok ? `${title} 测试消息发送成功` : `${title} 发送失败：${detail}`, res?.ok ? "info" : "danger");
            await refreshNotificationLogs();
          } catch (err) {
            toast(`测试失败：${err.message}`, "danger");
          } finally {
            testBtn.disabled = false;
          }
        },
      },
      icon("zap", 14),
      "发送测试"
    );

    return el(
      "div",
      { class: "channel-card" },
      el(
        "div",
        { class: "channel-head" },
        el("label", { class: "switch-inline" }, sw, el("strong", { class: "sm" }, title)),
        testBtn
      ),
      el(
        "div",
        { class: "channel-body" },
        ...fieldsSpec.map((f) =>
          field(
            f.label,
            el("input", {
              type: f.secret ? "password" : "text",
              value: c[f.prop] || "",
              placeholder: f.placeholder || "",
              onInput: (e) => {
                c[f.prop] = e.target.value;
              },
            })
          )
        )
      )
    );
  }

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, icon("save", 15), "保存通知设置");

  const form = el(
    "form",
    {
      class: "fl-card stack",
      onSubmit: async (e) => {
        e.preventDefault();
        saveBtn.disabled = true;
        try {
          await api.put("/api/notifications", collectFullConfig());
          toast("已保存告警推送配置");
        } catch (err) {
          toast(`保存失败：${err.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    cardHead("告警策略与推送通道", {
      iconName: "bell",
      subtitle: "任务失败、认证失效或部分失败时通过所选通道推送",
      actions: [el("label", { class: "switch-inline" }, globalEnabled, el("span", null, "启用告警推送"))],
    }),
    el(
      "div",
      { class: "form-grid-3" },
      field("同类型告警冷却 (分钟)", cooldownIn),
      el(
        "div",
        { class: "field", style: { justifyContent: "flex-end" } },
        el("label", { class: "switch-inline" }, recoverySwitch, el("span", null, "故障恢复时推送"))
      ),
      el(
        "div",
        { class: "field", style: { justifyContent: "flex-end" } },
        el("label", { class: "switch-inline" }, proxySwitch, el("span", null, "推送请求走全局代理"))
      )
    ),
    el(
      "div",
      { class: "fl-sub-card row-actions", style: { gap: "14px" } },
      el("span", { class: "muted xs" }, "触发事件："),
      ...["auth_error", "failed", "partial"].map((evKey) =>
        el(
          "label",
          { class: "switch-inline xs" },
          el("input", {
            type: "checkbox",
            checked: notifyOnSet.has(evKey),
            onChange: (e) => {
              if (e.target.checked) notifyOnSet.add(evKey);
              else notifyOnSet.delete(evKey);
            },
          }),
          el("span", null, evKey === "auth_error" ? "认证 / Cookie 失效" : evKey === "failed" ? "任务失败" : "部分失败")
        )
      )
    ),
    makeChannelCard("telegram", "Telegram Bot", [
      { prop: "bot_token", label: "Bot Token", secret: true, placeholder: "123456:ABC-DEF..." },
      { prop: "chat_id", label: "Chat ID", placeholder: "-1001234567890" },
      { prop: "api_base", label: "API Base URL (反代可选)", placeholder: "https://api.telegram.org" },
    ]),
    makeChannelCard("feishu", "飞书 / Lark 群机器人 Webhook", [
      { prop: "webhook_url", label: "Webhook URL", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
      { prop: "secret", label: "签名校验密钥 (可选)", secret: true },
    ]),
    makeChannelCard("bark", "Bark (iOS)", [
      { prop: "server_url", label: "服务器地址", placeholder: "https://api.day.app" },
      { prop: "device_key", label: "Device Key", secret: true },
      { prop: "group", label: "分组标签", placeholder: "gallery-dl" },
    ]),
    makeChannelCard("webhook", "自定义通用 Webhook (POST JSON)", [
      { prop: "url", label: "目标 URL", placeholder: "https://your-webhook.example/hook" },
      { prop: "headers_json", label: "自定义 Headers (JSON)", placeholder: '{"Authorization": "Bearer ..."}' },
    ]),
    el("div", { class: "row-actions", style: { justifyContent: "flex-end" } }, saveBtn)
  );

  const logsListWrap = el("div", { class: "stack xs-gap" });
  const renderNotificationLogs = (items) => {
    if (!items.length) {
      logsListWrap.replaceChildren(emptyState("暂无历史推送记录", "bell", "还没有推送记录"));
      return;
    }
    logsListWrap.replaceChildren(
      ...items.slice(0, 15).map((l) =>
        el(
          "div",
          { class: "fl-sub-card row-actions between" },
          el(
            "span",
            { class: "sm truncate", style: { flex: 1 } },
            `[${l.channel || "system"}] ${l.detail || ""}`
          ),
          l.run_id ? el("a", { class: "fl-badge info", href: `#runs/${l.run_id}` }, `Run #${l.run_id}`) : null,
          el("span", { class: `fl-badge ${l.status === "sent" ? "ok" : "err"}` }, l.status === "sent" ? "已发送" : "失败"),
          el("span", { class: "muted xs nowrap" }, fmtTimeShort(l.created_at))
        )
      )
    );
  };
  const refreshNotificationLogs = async () => {
    try {
      const next = await api.get("/api/notifications");
      if (isStale()) return;
      renderNotificationLogs(Array.isArray(next?.logs) ? next.logs : []);
    } catch {
      // Keep current logs if refresh fails transiently
    }
  };
  renderNotificationLogs(logs);

  const logsCard = el(
    "section",
    { class: "fl-card stack sm-gap" },
    cardHead("近期通知推送记录", { iconName: "activity" }),
    logsListWrap
  );

  root.replaceChildren(form, logsCard);
}

async function renderCookiesTab(root, isStale = () => false) {
  const [inputsRes, syncRes] = await Promise.all([
    api.get("/api/inputs").catch(() => null),
    api.get("/api/twitter-sync/status").catch(() => null),
  ]);
  if (isStale()) return;

  const files = Array.isArray(inputsRes?.files) ? inputsRes.files : [];
  const filePicker = el("input", { type: "file", accept: ".txt,text/plain", class: "fl-file-input" });
  const listEl = el("div", { class: "stack xs-gap" });

  const renderFiles = (items) => {
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.appendChild(emptyState("/data/inputs/ 目录下暂无 .txt 链接列表", "folder", "暂无列表文件"));
      return;
    }
    for (const f of items) {
      const name = typeof f === "string" ? f : f.name || f.filename;
      listEl.appendChild(
        el(
          "div",
          { class: "fl-sub-card row-actions between" },
          el(
            "div",
            { class: "row-actions xs-gap", style: { minWidth: 0 } },
            icon("file-text", 15),
            el("strong", { class: "sm truncate" }, name),
            f.url_count !== undefined ? el("span", { class: "muted xs nowrap" }, `${f.url_count} 条链接`) : null,
            f.size ? el("span", { class: "muted xs nowrap" }, fmtBytes(f.size)) : null
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn danger xs",
              onClick: async () => {
                const ok = await confirmModal({ title: "删除输入文件", message: `确定删除 ${name} 吗？`, okText: "删除", danger: true });
                if (!ok) return;
                try {
                  await api.del(`/api/inputs/${encodeURIComponent(name)}`);
                  toast(`已删除 ${name}`);
                  await renderCookiesTab(root, isStale);
                } catch (err) {
                  toast(`删除失败：${err.message}`, "danger");
                }
              },
            },
            icon("trash", 13),
            "删除"
          )
        )
      );
    }
  };
  renderFiles(files);

  const uploadBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn accent sm",
      onClick: async () => {
        const f = filePicker.files?.[0];
        if (!f) {
          toast("请先选择一个本地 .txt 文件", "danger");
          return;
        }
        try {
          const content = await f.text();
          await api.post("/api/inputs/upload", { filename: f.name, content });
          toast(`已上传 ${f.name} 到 /data/inputs/`);
          await renderCookiesTab(root, isStale);
        } catch (err) {
          toast(`上传失败：${err.message}`, "danger");
        }
      },
    },
    icon("upload", 14),
    "上传到 NAS 列表"
  );

  root.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "section",
        { class: "fl-card stack sm-gap" },
        cardHead("NAS 批量链接文件", {
          iconName: "folder",
          subtitle: "位于 /data/inputs/*.txt，可在任务或即时下载中以 -i 方式引用",
        }),
        el("div", { class: "file-picker-row" }, filePicker, uploadBtn),
        listEl
      ),
      el(
        "section",
        { class: "fl-card stack sm-gap" },
        cardHead("Twitter / X 永久红心同步中心", { iconName: "activity" }),
        el(
          "div",
          { class: "muted sm" },
          syncRes?.token
            ? `同步令牌已就绪 · 已归档 ${syncRes.count ?? 0} 条推文 ID（Archive ${syncRes.sources?.archive_sqlite ?? 0} / 磁盘 ${syncRes.sources?.disk ?? 0} / like.js ${syncRes.sources?.archive_js ?? 0} / 浏览器 ${syncRes.sources?.browser ?? 0}）`
            : "尚未获取同步状态，可前往站点详情页管理。"
        ),
        el(
          "div",
          { class: "row-actions" },
          el("a", { class: "fl-btn accent sm", href: "#site/twitter" }, icon("activity", 14), "前往 Twitter 站点配置"),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                try {
                  const res = await api.post("/api/twitter-sync/scan-disk", {});
                  toast(`扫描完成（新增回填 ${res?.inserted ?? 0} 条，总计 ${res?.count ?? 0} 条）`);
                  await renderCookiesTab(root, isStale);
                } catch (err) {
                  toast(`扫描失败：${err.message}`, "danger");
                }
              },
            },
            icon("folder", 14),
            "扫描磁盘回填 Archive"
          )
        )
      )
    )
  );
}

async function renderRawTab(root, ctx, isStale = () => false) {
  // Fetch raw JSON AND snapshot history from /api/config/overview
  const [rawRes, overviewRes] = await Promise.all([
    api.get("/api/config/raw"),
    api.get("/api/config/overview").catch(() => null),
  ]);
  if (isStale()) return;

  let rawText =
    typeof rawRes === "string"
      ? rawRes
      : rawRes?.config_json ?? rawRes?.content ?? JSON.stringify(rawRes?.config || rawRes || {}, null, 2);

  // Guard against double-encoded JSON strings
  if (typeof rawText === "string" && rawText.trim().startsWith('"')) {
    try {
      const inner = JSON.parse(rawText);
      if (typeof inner === "string") rawText = inner;
    } catch {
      // keep rawText
    }
  }

  const snapshots = Array.isArray(overviewRes?.snapshots)
    ? overviewRes.snapshots
    : Array.isArray(rawRes?.snapshots)
      ? rawRes.snapshots
      : [];

  const editor = el("textarea", {
    rows: 22,
    value: rawText,
    style: { fontFamily: "var(--mono)", fontSize: "0.75rem" },
  });
  const noteIn = el("input", {
    type: "text",
    placeholder: "本次修改备注（可选，例如：手动编辑站点 Cookie）",
    style: { flex: 1, minInlineSize: "200px" },
  });

  const saveBtn = el("button", { type: "button", class: "fl-btn accent" }, icon("save", 15), "保存原始配置 JSON");
  saveBtn.addEventListener("click", async () => {
    let parsed = null;
    try {
      parsed = JSON.parse(editor.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("根配置必须是 JSON 对象");
      }
    } catch (err) {
      toast(`JSON 格式校验失败：${err.message}`, "danger");
      return;
    }
    const ok = await confirmModal({
      title: "保存 gallery-dl 原始配置",
      message: "保存前系统会自动生成历史快照并标准化容器运行参数。确定写入修改后的 JSON 吗？",
      okText: "写入配置",
    });
    if (!ok) return;
    saveBtn.disabled = true;
    try {
      await api.put("/api/config/raw", {
        config_json: editor.value,
        note: noteIn.value.trim() || "手动编辑 JSON 配置",
      });
      toast("已写入原始配置并生成历史快照");
      await ctx?.refreshHeader?.();
      await renderRawTab(root, ctx, isStale);
    } catch (err) {
      toast(`保存失败：${err.message}`, "danger");
    } finally {
      saveBtn.disabled = false;
    }
  });

  const snapList = el(
    "section",
    { class: "fl-card stack sm-gap" },
    cardHead(`配置历史快照 (${snapshots.length})`, { iconName: "database" }),
    snapshots.length
      ? el(
          "div",
          { class: "stack xs-gap" },
          ...snapshots.map((s) =>
            el(
              "div",
              { class: "fl-sub-card row-actions between" },
              el(
                "div",
                { class: "stack xs-gap", style: { minWidth: 0 } },
                el("strong", { class: "sm" }, `快照 #${s.id}`),
                el("div", { class: "muted xs" }, `${fmtTimeShort(s.created_at)} · ${s.note || s.reason || "配置变更备份"}`)
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "fl-btn sm",
                  onClick: async () => {
                    const ok = await confirmModal({
                      title: "回滚历史快照",
                      message: `确定恢复到快照 #${s.id} (${s.note || fmtTimeShort(s.created_at)}) 吗？`,
                      okText: "恢复此版本",
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.post(`/api/config/snapshots/${encodeURIComponent(s.id)}/restore`, {});
                      toast(`已回滚至快照 #${s.id}`);
                      await ctx?.refreshHeader?.();
                      await renderRawTab(root, ctx, isStale);
                    } catch (err) {
                      toast(`回滚失败：${err.message}`, "danger");
                    }
                  },
                },
                "恢复此版本"
              )
            )
          )
        )
      : emptyState("暂无历史配置快照", "database", "还没有快照")
  );

  root.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "section",
        { class: "fl-card stack sm-gap" },
        cardHead("gallery-dl 原始 JSON 编辑器", {
          iconName: "file-text",
          subtitle: "直接修改 config.json；保存前会自动生成快照，可随时回滚",
          actions: [
            el(
              "button",
              {
                type: "button",
                class: "fl-btn sm",
                onClick: () => {
                  try {
                    editor.value = JSON.stringify(JSON.parse(editor.value), null, 2);
                    toast("已格式化 JSON");
                  } catch (err) {
                    toast(`JSON 解析失败：${err.message}`, "danger");
                  }
                },
              },
              "格式化"
            ),
            el(
              "button",
              {
                type: "button",
                class: "fl-btn sm",
                onClick: () => copyText(editor.value, "已复制完整配置 JSON"),
              },
              icon("copy", 14),
              "复制"
            ),
          ],
        }),
        editor,
        el("div", { class: "row-actions between" }, noteIn, saveBtn)
      ),
      snapList
    )
  );
}
