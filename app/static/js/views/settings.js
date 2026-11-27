import { api } from "../api.js";
import { el, toast, confirmModal, fmtTimeShort, fmtBytes, copyText } from "../util.js";
import { navigate } from "../router.js";

const TABS = [
  { id: "general", label: "全局与代理" },
  { id: "auth", label: "安全与口令" },
  { id: "notifications", label: "告警通知" },
  { id: "cookies", label: "列表与同步" },
  { id: "raw", label: "原始 JSON 与快照" },
];

export async function renderSettings(container, route, ctx) {
  const activeTab = TABS.some((t) => t.id === route.tab) ? route.tab : "general";

  const navEl = el(
    "nav",
    { class: "settings-nav fl-card stack xs-gap", "aria-label": "设置分类" },
    ...TABS.map((t) =>
      el(
        "a",
        {
          class: "fl-nav-item",
          href: `#settings/${t.id}`,
          "aria-current": t.id === activeTab ? "page" : undefined,
        },
        t.label
      )
    )
  );

  const bodyEl = el("div", { class: "stack" }, el("div", { class: "fl-infobar" }, "正在载入设置项…"));

  container.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "div",
        null,
        el("h1", { class: "fl-page-title", style: { margin: 0, fontSize: "1.35rem" } }, "系统设置"),
        el("div", { class: "muted xs" }, "管理全局下载策略、控制台密码、多通道告警通知、NAS 列表及原始配置快照")
      ),
      el("div", { class: "settings-layout" }, navEl, bodyEl)
    )
  );

  if (activeTab === "general") {
    await renderGeneralTab(bodyEl, ctx);
  } else if (activeTab === "auth") {
    await renderAuthTab(bodyEl, ctx);
  } else if (activeTab === "notifications") {
    await renderNotificationsTab(bodyEl);
  } else if (activeTab === "cookies") {
    await renderCookiesTab(bodyEl);
  } else if (activeTab === "raw") {
    await renderRawTab(bodyEl, ctx);
  }
}

async function renderGeneralTab(root, ctx) {
  const overview = await api.get("/api/config/overview");
  const cfg = overview?.global_config || overview?.settings || {};

  const baseDirIn = el("input", { type: "text", value: cfg["base-directory"] || "/gallery-dl" });
  const proxyIn = el("input", { type: "text", value: cfg.proxy || "", placeholder: "http://host.docker.internal:7890" });
  const skipIn = el("input", { type: "text", value: cfg.skip || "abort:7", placeholder: "abort:7" });
  const sleepIn = el("input", { type: "number", step: "0.5", min: "0", value: cfg["sleep-request"] ?? 1 });
  const retriesIn = el("input", { type: "number", min: "0", value: cfg.retries ?? 4 });
  const timeoutIn = el("input", { type: "number", min: "1", value: cfg.timeout ?? 30 });
  const filenameIn = el("input", { type: "text", value: cfg.filename || "" });
  const archiveIn = el("input", { type: "text", value: cfg.archive || "/data/archive.sqlite3" });

  const proxyStatus = el("div", { class: "muted xs hidden" });

  const testProxyBtn = el(
    "button",
    {
      type: "button",
      class: "fl-btn sm",
      onClick: async () => {
        const p = proxyIn.value.trim();
        if (!p) {
          toast("请先填写代理地址", "danger");
          return;
        }
        testProxyBtn.disabled = true;
        proxyStatus.classList.remove("hidden");
        proxyStatus.textContent = "正在测试代理连通性…";
        try {
          const res = await api.post("/api/config/proxy-test", { proxy_url: p });
          proxyStatus.textContent = res?.ok === false
            ? `连接失败：${res.error || res.message}`
            : `连接正常（延迟 ${res?.latency_ms ?? "?"} ms${res?.ip ? ` · 出口 ${res.ip}` : ""}）`;
          toast("代理连通性测试完成");
        } catch (err) {
          proxyStatus.textContent = `测试失败：${err.message}`;
          toast(`代理测试失败：${err.message}`, "danger");
        } finally {
          testProxyBtn.disabled = false;
        }
      },
    },
    "测试代理连通性"
  );

  const postPreviewOut = el("pre", { class: "cmd-preview hidden" });

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, "保存全局配置");

  root.replaceChildren(
    el(
      "form",
      {
        class: "fl-card stack",
        onSubmit: async (e) => {
          e.preventDefault();
          saveBtn.disabled = true;
          try {
            await api.put("/api/config/settings", {
              "base-directory": baseDirIn.value.trim() || "/gallery-dl",
              proxy: proxyIn.value.trim() || null,
              skip: skipIn.value.trim() || "abort:7",
              "sleep-request": Number(sleepIn.value || 0),
              retries: Number(retriesIn.value || 0),
              timeout: Number(timeoutIn.value || 30),
              filename: filenameIn.value.trim() || undefined,
              archive: archiveIn.value.trim() || undefined,
            });
            toast("已保存全局配置");
            await ctx?.refreshHeader?.();
          } catch (err) {
            toast(`保存失败：${err.message}`, "danger");
          } finally {
            saveBtn.disabled = false;
          }
        },
      },
      el("h2", { class: "fl-card-title", style: { margin: 0 } }, "全局下载策略与网络代理"),
      el(
        "div",
        { class: "form-grid-2" },
        el("div", { class: "field" }, el("label", null, "默认媒体输出根目录"), baseDirIn),
        el("div", { class: "field" }, el("label", null, "全局 SQLite Archive 库路径"), archiveIn)
      ),
      el(
        "div",
        { class: "field" },
        el("label", null, "全局代理 URL (HTTP / SOCKS5)"),
        el("div", { class: "input-with-btn" }, proxyIn, testProxyBtn),
        proxyStatus
      ),
      el(
        "div",
        { class: "form-grid-3" },
        el("div", { class: "field" }, el("label", null, "全局 Skip 策略"), skipIn),
        el("div", { class: "field" }, el("label", null, "默认请求间隔 (秒)"), sleepIn),
        el("div", { class: "field" }, el("label", null, "网络重试 / 超时 (秒)"), el("div", { class: "row-actions" }, retriesIn, timeoutIn))
      ),
      el("div", { class: "field" }, el("label", null, "全局默认文件名模板 (留空使用各站点默认)"), filenameIn),
      el(
        "div",
        { class: "row-actions between" },
        el(
          "button",
          {
            type: "button",
            class: "fl-btn sm",
            onClick: async () => {
              const res = await api.post("/api/config/postprocess-preview", {}).catch((e) => ({ error: e.message }));
              postPreviewOut.classList.remove("hidden");
              postPreviewOut.textContent = JSON.stringify(res, null, 2);
            },
          },
          "预览默认 ExifTool 后处理规则"
        ),
        saveBtn
      ),
      postPreviewOut
    )
  );
}

async function renderAuthTab(root) {
  const status = await api.get("/api/auth/status", { noAuthRedirect: true }).catch(() => ({ auth_disabled: true }));
  if (status?.auth_disabled) {
    root.replaceChildren(
      el(
        "div",
        { class: "fl-card stack" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "Web 登录认证状态"),
        el("div", { class: "fl-infobar warn" }, "当前容器通过环境变量禁用了登录认证（AUTH_DISABLED=1）。若控制台暴露在局域网/公网中，请务必关闭该选项。"),
        el("div", { class: "muted xs" }, "已启用状态可在容器内查看 /setup 初始化与口令校验策略。")
      )
    );
    return;
  }

  const curIn = el("input", { type: "password", required: true, autocomplete: "current-password", "aria-invalid": "false" });
  const newIn = el("input", { type: "password", required: true, minlength: 6, autocomplete: "new-password", "aria-invalid": "false", placeholder: "至少 6 位" });
  const new2In = el("input", { type: "password", required: true, minlength: 6, autocomplete: "new-password", "aria-invalid": "false", placeholder: "再次输入新密码" });
  const submitBtn = el("button", { type: "submit", class: "fl-btn accent" }, "更新管理员密码");

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
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "修改管理员密码"),
        el("div", { class: "field" }, el("label", null, "当前密码"), curIn),
        el(
          "div",
          { class: "form-grid-2" },
          el("div", { class: "field" }, el("label", null, "新密码"), newIn),
          el("div", { class: "field" }, el("label", null, "确认新密码"), new2In)
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
                await api.post("/api/auth/logout", {});
                location.replace("/login");
              },
            },
            "退出当前会话"
          ),
          submitBtn
        )
      )
    )
  );
}

async function renderNotificationsTab(root) {
  const data = await api.get("/api/notifications");
  const cfg = data?.config || data || {};
  const channels = cfg.channels || {};
  const logs = data?.logs || data?.recent_logs || [];

  const globalEnabled = el("input", { type: "checkbox", role: "switch", switch: true, checked: cfg.enabled !== false });
  const cooldownIn = el("input", { type: "number", min: 0, value: cfg.cooldown_minutes ?? 30 });
  const recoverySwitch = el("input", { type: "checkbox", role: "switch", switch: true, checked: Boolean(cfg.notify_on_recovery) });
  const proxySwitch = el("input", { type: "checkbox", role: "switch", switch: true, checked: cfg.use_proxy !== false });

  const chState = {
    telegram: { enabled: Boolean(channels.telegram?.enabled), bot_token: channels.telegram?.bot_token || "", chat_id: channels.telegram?.chat_id || "", thread_id: channels.telegram?.thread_id || "" },
    feishu: { enabled: Boolean(channels.feishu?.enabled), webhook_url: channels.feishu?.webhook_url || "", secret: channels.feishu?.secret || "" },
    bark: { enabled: Boolean(channels.bark?.enabled), server_url: channels.bark?.server_url || "https://api.day.app", device_key: channels.bark?.device_key || "", group: channels.bark?.group || "gallery-dl" },
    webhook: { enabled: Boolean(channels.webhook?.enabled), url: channels.webhook?.url || "", secret: channels.webhook?.secret || "" },
  };

  function makeChannelCard(key, title, fieldsSpec) {
    const c = chState[key];
    const sw = el("input", {
      type: "checkbox",
      role: "switch",
      switch: true,
      checked: c.enabled,
      onChange: (e) => { c.enabled = e.target.checked; },
    });
    const testBtn = el(
      "button",
      {
        type: "button",
        class: "fl-btn sm",
        onClick: async () => {
          testBtn.disabled = true;
          try {
            await api.post("/api/notifications/test", { channel: key, config: { ...c, use_proxy: proxySwitch.checked } });
            toast(`${title} 测试消息已发送`);
          } catch (err) {
            toast(`测试失败：${err.message}`, "danger");
          } finally {
            testBtn.disabled = false;
          }
        },
      },
      "发送测试"
    );

    return el(
      "div",
      { class: "fl-sub-card stack sm-gap" },
      el(
        "div",
        { class: "row-actions between" },
        el("label", { class: "switch-inline" }, sw, el("strong", { class: "sm" }, title)),
        testBtn
      ),
      el(
        "div",
        { class: "form-grid-2" },
        ...fieldsSpec.map((f) =>
          el(
            "div",
            { class: "field" },
            el("label", null, f.label),
            el("input", {
              type: f.secret ? "password" : "text",
              value: c[f.prop] || "",
              placeholder: f.placeholder || "",
              onInput: (e) => { c[f.prop] = e.target.value; },
            })
          )
        )
      )
    );
  }

  const saveBtn = el("button", { type: "submit", class: "fl-btn accent" }, "保存通知设置");

  const form = el(
    "form",
    {
      class: "fl-card stack",
      onSubmit: async (e) => {
        e.preventDefault();
        saveBtn.disabled = true;
        try {
          await api.put("/api/notifications", {
            enabled: globalEnabled.checked,
            cooldown_minutes: Number(cooldownIn.value || 0),
            notify_on_recovery: recoverySwitch.checked,
            use_proxy: proxySwitch.checked,
            channels: chState,
          });
          toast("已保存告警推送配置");
        } catch (err) {
          toast(`保存失败：${err.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    el(
      "div",
      { class: "row-actions between" },
      el("h2", { class: "fl-card-title", style: { margin: 0 } }, "告警策略与推送通道"),
      el("label", { class: "switch-inline" }, globalEnabled, el("span", null, "启用告警推送"))
    ),
    el(
      "div",
      { class: "form-grid-3" },
      el("div", { class: "field" }, el("label", null, "同类型告警冷却时间 (分钟)"), cooldownIn),
      el("div", { class: "field", style: { justifyContent: "flex-end" } }, el("label", { class: "switch-inline" }, recoverySwitch, el("span", null, "故障恢复时推送通知"))),
      el("div", { class: "field", style: { justifyContent: "flex-end" } }, el("label", { class: "switch-inline" }, proxySwitch, el("span", null, "推送请求走全局代理")))
    ),
    makeChannelCard("telegram", "Telegram Bot", [
      { prop: "bot_token", label: "Bot Token", secret: true, placeholder: "123456:ABC-DEF..." },
      { prop: "chat_id", label: "Chat ID", placeholder: "-1001234567890" },
      { prop: "thread_id", label: "Topic Thread ID (可选)", placeholder: "留空发往主会话" },
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
      { prop: "secret", label: "HMAC / Bearer Secret (可选)", secret: true },
    ]),
    el("div", { class: "row-actions", style: { justifyContent: "flex-end" } }, saveBtn)
  );

  const logsCard = el(
    "section",
    { class: "fl-card stack sm-gap" },
    el("h2", { class: "fl-card-title", style: { margin: 0 } }, "近期通知推送记录"),
    logs.length
      ? el(
          "div",
          { class: "stack xs-gap" },
          ...logs.slice(0, 10).map((l) =>
            el(
              "div",
              { class: "fl-sub-card row-actions between" },
              el("span", { class: "sm" }, `[${l.channel || "system"}] ${l.title || l.message || ""}`),
              el("span", { class: `fl-badge ${l.ok === false ? "err" : "ok"}` }, l.ok === false ? "失败" : "已发送"),
              el("span", { class: "muted xs" }, fmtTimeShort(l.created_at))
            )
          )
        )
      : el("div", { class: "empty-state" }, "暂无历史推送记录")
  );

  root.replaceChildren(form, logsCard);
}

async function renderCookiesTab(root) {
  const [inputsRes, syncRes] = await Promise.all([
    api.get("/api/inputs").catch(() => null),
    api.get("/api/twitter-sync/status").catch(() => null),
  ]);

  const files = inputsRes?.files || inputsRes?.items || (Array.isArray(inputsRes) ? inputsRes : []);
  const filePicker = el("input", { type: "file", accept: ".txt,text/plain", class: "fl-file-input" });
  const listEl = el("div", { class: "stack xs-gap" });

  const renderFiles = (items) => {
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.appendChild(el("div", { class: "empty-state" }, "/data/inputs/ 目录下暂无 .txt 链接列表"));
      return;
    }
    for (const f of items) {
      const name = typeof f === "string" ? f : f.filename || f.name;
      listEl.appendChild(
        el(
          "div",
          { class: "fl-sub-card row-actions between" },
          el(
            "div",
            null,
            el("strong", { class: "sm" }, name),
            f.size ? el("span", { class: "muted xs", style: { marginInlineStart: "0.5rem" } }, fmtBytes(f.size)) : null
          ),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn danger xs",
              onClick: async () => {
                const ok = await confirmModal({ title: "删除输入文件", message: `确定删除 ${name} 吗？`, okText: "删除", danger: true });
                if (!ok) return;
                await api.del(`/api/inputs/${encodeURIComponent(name)}`);
                toast(`已删除 ${name}`);
                await renderCookiesTab(root);
              },
            },
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
        const content = await f.text();
        await api.post("/api/inputs/upload", { filename: f.name, content });
        toast(`已上传 ${f.name} 到 /data/inputs/`);
        await renderCookiesTab(root);
      },
    },
    "上传到 NAS 列表"
  );

  root.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "section",
        { class: "fl-card stack sm-gap" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "NAS 批量链接文件 (/data/inputs/*.txt)"),
        el("div", { class: "file-picker-row" }, filePicker, uploadBtn),
        listEl
      ),
      el(
        "section",
        { class: "fl-card stack sm-gap" },
        el("h2", { class: "fl-card-title", style: { margin: 0 } }, "Twitter / X Cookie 同步中心"),
        el(
          "div",
          { class: "muted sm" },
          syncRes?.token_configured
            ? `已启用同步令牌 · 最近同步：${syncRes.last_sync_at || "尚未触发"}`
            : "尚未初始化 Twitter 同步，可前往站点详情页一键生成令牌并安装油猴脚本。"
        ),
        el(
          "div",
          { class: "row-actions" },
          el("a", { class: "fl-btn accent sm", href: "#site/twitter" }, "前往 Twitter 站点配置 →"),
          el(
            "button",
            {
              type: "button",
              class: "fl-btn sm",
              onClick: async () => {
                const res = await api.post("/api/twitter-sync/scan-disk", {});
                toast(res?.message || `扫描完成（回填 ${res?.inserted ?? 0} 条）`);
              },
            },
            "扫描磁盘回填 Archive"
          )
        )
      )
    )
  );
}

async function renderRawTab(root, ctx) {
  const rawRes = await api.get("/api/config/raw");
  const rawText = typeof rawRes === "string" ? rawRes : rawRes?.content || JSON.stringify(rawRes?.config || rawRes || {}, null, 2);
  const snapshots = rawRes?.snapshots || [];

  const editor = el("textarea", {
    rows: 18,
    value: rawText,
    style: { fontFamily: "var(--fl-mono)", fontSize: "0.78rem" },
  });

  const saveBtn = el("button", { type: "button", class: "fl-btn accent" }, "保存原始配置 JSON");
  saveBtn.addEventListener("click", async () => {
    try {
      JSON.parse(editor.value);
    } catch (err) {
      toast(`JSON 语法错误：${err.message}`, "danger");
      return;
    }
    const ok = await confirmModal({
      title: "覆写 gallery-dl.json",
      message: "保存前系统会自动备份当前配置快照。确定写入修改后的 JSON 吗？",
      okText: "写入配置",
    });
    if (!ok) return;
    saveBtn.disabled = true;
    try {
      await api.put("/api/config/raw", { content: editor.value });
      toast("已写入原始配置 JSON");
      await ctx?.refreshHeader?.();
      await renderRawTab(root, ctx);
    } catch (err) {
      toast(`保存失败：${err.message}`, "danger");
    } finally {
      saveBtn.disabled = false;
    }
  });

  const snapList = el(
    "section",
    { class: "fl-card stack sm-gap" },
    el("h2", { class: "fl-card-title", style: { margin: 0 } }, "配置历史快照"),
    snapshots.length
      ? el(
          "div",
          { class: "stack xs-gap" },
          ...snapshots.map((s) =>
            el(
              "div",
              { class: "fl-sub-card row-actions between" },
              el("div", null, el("strong", { class: "sm" }, `快照 #${s.id}`), el("div", { class: "muted xs" }, `${fmtTimeShort(s.created_at)} · ${s.reason || "手动/修改备份"}`)),
              el(
                "button",
                {
                  type: "button",
                  class: "fl-btn sm",
                  onClick: async () => {
                    const ok = await confirmModal({
                      title: "恢复历史快照",
                      message: `确定恢复快照 #${s.id} 吗？当前配置将自动再备份一次。`,
                      okText: "恢复此版本",
                      danger: true,
                    });
                    if (!ok) return;
                    await api.post(`/api/config/snapshots/${encodeURIComponent(s.id)}/restore`, {});
                    toast(`已恢复配置快照 #${s.id}`);
                    await renderRawTab(root, ctx);
                  },
                },
                "恢复此版本"
              )
            )
          )
        )
      : el("div", { class: "empty-state" }, "暂无历史配置快照")
  );

  root.replaceChildren(
    el(
      "div",
      { class: "stack" },
      el(
        "section",
        { class: "fl-card stack sm-gap" },
        el(
          "div",
          { class: "row-actions between" },
          el("h2", { class: "fl-card-title", style: { margin: 0 } }, "gallery-dl.json 原始编辑器"),
          el(
            "div",
            { class: "row-actions" },
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
              "复制"
            )
          )
        ),
        editor,
        el("div", { class: "row-actions", style: { justifyContent: "flex-end" } }, saveBtn)
      ),
      snapList
    )
  );
}
