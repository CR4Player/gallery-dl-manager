import { api, getConfigOverview, invalidateSharedCache } from "../api.js";
import { confirmDialog, esc, fmtTime, showToast, upgradeSwitches } from "../util.js";

let hostEl = null;
let unmounted = false;
let currentSection = "general";

const SECTIONS = [
  { id: "general", label: "常规与外观" },
  { id: "notifications", label: "通知渠道" },
  { id: "security", label: "安全与会话" },
  { id: "integrations", label: "集成与输入列表" },
  { id: "advanced", label: "原始 JSON 与快照" },
];

function applyThemeChoice(choice) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  try {
    if (choice === "system") localStorage.removeItem("color-scheme");
    else localStorage.setItem("color-scheme", choice);
  } catch {}
  if (meta) meta.content = choice === "system" ? "light dark" : choice;
}

function getThemeChoice() {
  try {
    const saved = localStorage.getItem("color-scheme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

async function renderGeneral(pane) {
  const ov = await getConfigOverview(true);
  if (unmounted) return;
  const s = ov.settings || {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const choice = getThemeChoice();

  pane.innerHTML = `
    <div class="stack">
      <section class="card">
        <div class="card-head"><h2>全局下载与后处理设置</h2></div>
        <form id="set-global-form" class="stack">
          <div class="field">
            <label for="cfg-global-proxy">全局默认代理</label>
            <span class="hint">宿主机代理可用 <code>http://host.docker.internal:端口</code>，直连留空</span>
            <div class="input-with-btn">
              <input id="cfg-global-proxy" type="text" value="${esc(s.global_proxy || "")}" placeholder="例如 http://host.docker.internal:7890">
              <button type="button" class="btn" id="test-proxy-btn">测试连通</button>
            </div>
            <div id="proxy-test-result" class="sm muted"></div>
          </div>

          <div class="form-grid-2">
            <div class="field">
              <label for="cfg-default-skip">全局 Skip 策略</label>
              <input id="cfg-default-skip" type="text" value="${esc(ov.default_skip ?? "")}" placeholder="abort:7">
            </div>
            <div class="field">
              <label for="cfg-retries">下载重试次数</label>
              <input id="cfg-retries" type="number" min="0" max="20" value="${ov.downloader?.retries ?? 4}">
            </div>
            <div class="field">
              <label for="cfg-timeout">请求超时 (秒)</label>
              <input id="cfg-timeout" type="number" min="5" max="300" value="${ov.downloader?.timeout ?? 30}">
            </div>
            <div class="field">
              <label for="cfg-retention">日志保留天数</label>
              <input id="cfg-retention" type="number" min="1" max="365" value="${s.log_retention_days ?? 30}">
            </div>
            <div class="field">
              <label for="cfg-concurrency">最大并发任务数 (重启生效)</label>
              <select id="cfg-concurrency">
                <option value="1" ${String(s.max_concurrency ?? 1) === "1" ? "selected" : ""}>1 (推荐，稳妥串行)</option>
                <option value="2" ${String(s.max_concurrency ?? 1) === "2" ? "selected" : ""}>2</option>
                <option value="3" ${String(s.max_concurrency ?? 1) === "3" ? "selected" : ""}>3</option>
              </select>
            </div>
            <div class="field">
              <label for="cfg-pp-sites">默认启用 ExifTool 的站点</label>
              <input id="cfg-pp-sites" type="text" value="${esc((s.postprocess_default_sites || []).join(","))}" placeholder="twitter,bluesky">
            </div>
          </div>
          <div><button type="submit" class="btn primary">保存全局设置</button></div>
        </form>
      </section>

      <section class="card stack">
        <div class="card-head" style="margin-bottom:0;"><h2>外观主题</h2></div>
        <span class="hint">默认跟随操作系统浅色 / 深色偏好；也可在此固定配色</span>
        <div class="segmented" role="radiogroup" aria-label="外观配色选择">
          <button type="button" class="seg-btn" data-theme-choice="system" aria-pressed="${choice === "system"}">跟随系统 (<span id="sys-scheme-hint">${mq.matches ? "当前深色" : "当前浅色"}</span>)</button>
          <button type="button" class="seg-btn" data-theme-choice="light" aria-pressed="${choice === "light"}">浅色</button>
          <button type="button" class="seg-btn" data-theme-choice="dark" aria-pressed="${choice === "dark"}">深色</button>
        </div>
      </section>
    </div>
  `;

  pane.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.themeChoice;
      applyThemeChoice(val);
      pane.querySelectorAll("[data-theme-choice]").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.themeChoice === val));
      });
    });
  });

  document.getElementById("test-proxy-btn").addEventListener("click", async () => {
    const out = document.getElementById("proxy-test-result");
    out.textContent = "测试中…";
    try {
      const res = await api("/api/config/proxy-test", {
        method: "POST",
        body: { proxy_url: document.getElementById("cfg-global-proxy").value.trim() },
      });
      out.textContent = res.ok ? `连接成功 (HTTP ${res.status})` : `失败：${res.detail}`;
    } catch (err) {
      out.textContent = err.message;
    }
  });

  document.getElementById("set-global-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/config/settings", {
        method: "PUT",
        body: {
          global_proxy: document.getElementById("cfg-global-proxy").value.trim(),
          default_skip: document.getElementById("cfg-default-skip").value.trim(),
          retries: Number(document.getElementById("cfg-retries").value || 4),
          timeout: Number(document.getElementById("cfg-timeout").value || 30),
          log_retention_days: Number(document.getElementById("cfg-retention").value || 30),
          max_concurrency: Number(document.getElementById("cfg-concurrency").value || 1),
          postprocess_default_sites: document
            .getElementById("cfg-pp-sites")
            .value.split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });
      invalidateSharedCache();
      showToast("全局设置已保存");
    } catch (err) {
      showToast(err.message, "danger");
    }
  });
}

async function renderNotifications(pane) {
  const data = await api("/api/notifications");
  if (unmounted) return;
  const c = data.config || {};
  const evSet = new Set(c.notify_on || []);

  pane.innerHTML = `
    <div class="stack">
      <form id="set-notify-form" class="stack">
        <section class="card stack">
          <div class="card-head" style="margin-bottom:0;">
            <div>
              <h2>失败与异常通知设置</h2>
              <p class="muted sm" style="margin:0.2rem 0 0;">支持任务失败、认证失效、403 拦截与恢复通知，内置冷却防刷屏</p>
            </div>
            <label class="checkbox-inline"><input type="checkbox" switch role="switch" class="switch-ok" id="notif-enabled" ${c.enabled ? "checked" : ""}> 启用失败通知</label>
          </div>
          <div class="form-grid-3">
            <div class="field">
              <span class="label-text">触发事件</span>
              <div class="stack xs-gap">
                <label class="checkbox-inline"><input type="checkbox" class="checkbox-custom notif-event" value="failed" ${evSet.has("failed") ? "checked" : ""}> 任务完全失败 (failed)</label>
                <label class="checkbox-inline"><input type="checkbox" class="checkbox-custom notif-event" value="auth_error" ${evSet.has("auth_error") ? "checked" : ""}> Cookie / 认证失效 (auth_error)</label>
                <label class="checkbox-inline"><input type="checkbox" class="checkbox-custom notif-event" value="partial" ${evSet.has("partial") ? "checked" : ""}> 部分失败 / 403 拦截 (partial)</label>
              </div>
            </div>
            <div class="field">
              <label for="notif-cooldown">同类告警冷却时间 (分钟)</label>
              <span class="hint">同一任务同类错误在冷却期内不重复刷屏</span>
              <input id="notif-cooldown" type="number" min="0" max="10080" value="${c.cooldown_minutes ?? 60}">
            </div>
            <div class="field">
              <span class="label-text">附加选项</span>
              <div class="stack xs-gap">
                <label class="checkbox-inline"><input type="checkbox" switch role="switch" id="notif-recovery" ${c.notify_on_recovery ? "checked" : ""}> 恢复正常时发送恢复通知</label>
                <label class="checkbox-inline"><input type="checkbox" switch role="switch" id="notif-use-proxy" ${c.use_proxy ? "checked" : ""}> 推送请求走全局代理</label>
              </div>
            </div>
          </div>
        </section>

        <div class="two-col">
          <section class="card stack sm-gap">
            <div class="card-head" style="margin-bottom:0;">
              <h3>Telegram Bot</h3>
              <label class="checkbox-inline"><input type="checkbox" switch role="switch" class="switch-ok" id="tg-enabled" ${c.telegram?.enabled ? "checked" : ""}> 启用</label>
            </div>
            <div class="field"><label for="tg-token">Bot Token</label><input id="tg-token" type="password" value="${esc(c.telegram?.bot_token || "")}" placeholder="123456:ABC-DEF..."></div>
            <div class="field"><label for="tg-chat">Chat ID</label><input id="tg-chat" type="text" value="${esc(c.telegram?.chat_id || "")}" placeholder="123456789"></div>
            <div class="field"><label for="tg-base">API Base</label><input id="tg-base" type="url" value="${esc(c.telegram?.api_base || "https://api.telegram.org")}"></div>
            <button type="button" class="btn sm test-channel-btn" data-channel="telegram">发送 Telegram 测试</button>
          </section>

          <section class="card stack sm-gap">
            <div class="card-head" style="margin-bottom:0;">
              <h3>飞书自定义机器人</h3>
              <label class="checkbox-inline"><input type="checkbox" switch role="switch" class="switch-ok" id="fs-enabled" ${c.feishu?.enabled ? "checked" : ""}> 启用</label>
            </div>
            <div class="field"><label for="fs-url">Webhook URL</label><input id="fs-url" type="url" value="${esc(c.feishu?.webhook_url || "")}" placeholder="https://open.feishu.cn/..."></div>
            <div class="field"><label for="fs-secret">签名密钥 Secret</label><input id="fs-secret" type="password" value="${esc(c.feishu?.secret || "")}"></div>
            <button type="button" class="btn sm test-channel-btn" data-channel="feishu">发送飞书测试</button>
          </section>

          <section class="card stack sm-gap">
            <div class="card-head" style="margin-bottom:0;">
              <h3>Bark (iOS)</h3>
              <label class="checkbox-inline"><input type="checkbox" switch role="switch" class="switch-ok" id="bk-enabled" ${c.bark?.enabled ? "checked" : ""}> 启用</label>
            </div>
            <div class="field"><label for="bk-server">Server URL</label><input id="bk-server" type="url" value="${esc(c.bark?.server_url || "https://api.day.app")}"></div>
            <div class="field"><label for="bk-key">Device Key</label><input id="bk-key" type="password" value="${esc(c.bark?.device_key || "")}"></div>
            <div class="field"><label for="bk-group">推送分组</label><input id="bk-group" type="text" value="${esc(c.bark?.group || "gallery-dl")}"></div>
            <button type="button" class="btn sm test-channel-btn" data-channel="bark">发送 Bark 测试</button>
          </section>

          <section class="card stack sm-gap">
            <div class="card-head" style="margin-bottom:0;">
              <h3>通用 JSON Webhook</h3>
              <label class="checkbox-inline"><input type="checkbox" switch role="switch" class="switch-ok" id="wh-enabled" ${c.webhook?.enabled ? "checked" : ""}> 启用</label>
            </div>
            <div class="field"><label for="wh-url">Webhook URL</label><input id="wh-url" type="url" value="${esc(c.webhook?.url || "")}" placeholder="https://example.com/hook"></div>
            <div class="field"><label for="wh-headers">自定义 Headers (JSON)</label><textarea id="wh-headers" rows="2">${esc(c.webhook?.headers_json || "{}")}</textarea></div>
            <button type="button" class="btn sm test-channel-btn" data-channel="webhook">发送 Webhook 测试</button>
          </section>
        </div>

        <div class="row-actions">
          <button type="submit" class="btn primary">保存通知配置</button>
          <span id="notif-test-status" class="muted sm"></span>
        </div>
      </form>

      <section class="card">
        <div class="card-head"><h2>近期通知发送记录</h2></div>
        <div tabindex="0" role="region" aria-labelledby="notif-log-cap" class="table-wrapper">
          <table class="data-table">
            <caption id="notif-log-cap" class="visually-hidden">通知发送历史</caption>
            <thead><tr><th>时间</th><th>关联 Run</th><th>通道</th><th>结果</th><th>详情</th></tr></thead>
            <tbody>
              ${(data.logs || []).length
                ? data.logs
                    .map(
                      (l) => `
                  <tr>
                    <td data-label="时间">${fmtTime(l.created_at)}</td>
                    <td data-label="关联 Run">${l.run_id ? `<a href="#/runs/${l.run_id}">#${l.run_id}</a>` : "测试"}</td>
                    <td data-label="通道">${esc(l.channel)}</td>
                    <td data-label="结果">${l.status === "sent" ? '<span class="badge success">成功</span>' : '<span class="badge failed">失败</span>'}</td>
                    <td data-label="详情" class="sm">${esc(l.detail)}</td>
                  </tr>`
                    )
                    .join("")
                : `<tr><td colspan="5" class="muted">暂无推送记录。</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
  upgradeSwitches(pane);

  const collect = () => ({
    enabled: document.getElementById("notif-enabled").checked,
    notify_on: [...pane.querySelectorAll(".notif-event:checked")].map((cb) => cb.value),
    notify_on_recovery: document.getElementById("notif-recovery").checked,
    cooldown_minutes: Number(document.getElementById("notif-cooldown").value || 60),
    use_proxy: document.getElementById("notif-use-proxy").checked,
    telegram: {
      enabled: document.getElementById("tg-enabled").checked,
      bot_token: document.getElementById("tg-token").value.trim(),
      chat_id: document.getElementById("tg-chat").value.trim(),
      api_base: document.getElementById("tg-base").value.trim() || "https://api.telegram.org",
    },
    feishu: {
      enabled: document.getElementById("fs-enabled").checked,
      webhook_url: document.getElementById("fs-url").value.trim(),
      secret: document.getElementById("fs-secret").value.trim(),
    },
    bark: {
      enabled: document.getElementById("bk-enabled").checked,
      server_url: document.getElementById("bk-server").value.trim() || "https://api.day.app",
      device_key: document.getElementById("bk-key").value.trim(),
      group: document.getElementById("bk-group").value.trim() || "gallery-dl",
    },
    webhook: {
      enabled: document.getElementById("wh-enabled").checked,
      url: document.getElementById("wh-url").value.trim(),
      headers_json: document.getElementById("wh-headers").value.trim() || "{}",
    },
  });

  document.getElementById("set-notify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/notifications", { method: "PUT", body: collect() });
      showToast("通知配置已保存");
      await renderNotifications(pane);
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  pane.querySelectorAll(".test-channel-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ch = btn.dataset.channel;
      const out = document.getElementById("notif-test-status");
      out.textContent = `正在发送 ${ch} 测试…`;
      try {
        const res = await api("/api/notifications/test", {
          method: "POST",
          body: { channel: ch, config: collect() },
        });
        const first = res.results?.[0];
        out.textContent = first?.ok ? `${ch} 测试发送成功` : `${ch} 发送失败：${first?.detail || "未知错误"}`;
      } catch (err) {
        out.textContent = err.message;
      }
    });
  });
}

async function renderSecurity(pane) {
  pane.innerHTML = `
    <div class="stack">
      <section class="card stack">
        <div class="card-head" style="margin-bottom:0;"><h2>修改管理员登录密码</h2></div>
        <form id="set-pw-form" class="stack" novalidate>
          <div class="form-grid-2">
            <div class="field">
              <label for="pw-current">当前密码</label>
              <input id="pw-current" type="password" required autocomplete="current-password">
            </div>
            <div class="field">
              <label for="pw-new">新密码 (≥6位)</label>
              <input id="pw-new" type="password" required minlength="6" autocomplete="new-password">
            </div>
          </div>
          <div><button type="submit" class="btn primary">更新登录密码</button></div>
        </form>
      </section>

      <section class="card banner-row">
        <div>
          <strong>当前会话</strong>
          <div class="muted sm">退出后需重新输入管理员密码登录控制台</div>
        </div>
        <button type="button" class="btn danger" id="set-logout-btn">退出登录</button>
      </section>
    </div>
  `;

  document.getElementById("set-pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: {
          current_password: document.getElementById("pw-current").value,
          new_password: document.getElementById("pw-new").value,
        },
      });
      e.target.reset();
      showToast("密码已更新");
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  document.getElementById("set-logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.replace("/login");
  });
}

async function renderIntegrations(pane) {
  const [tw, inputs] = await Promise.all([
    api("/api/twitter-sync/status").catch((err) => ({ error: err.message })),
    api("/api/inputs").catch(() => ({ files: [] })),
  ]);
  if (unmounted) return;
  const s = tw.sources || {};
  const files = inputs.files || [];

  pane.innerHTML = `
    <div class="stack">
      <section class="card stack">
        <div class="card-head" style="margin-bottom:0;">
          <div>
            <h2>Twitter 永久红心同步（油猴脚本）</h2>
            <p class="muted sm" style="margin:0.2rem 0 0;">汇总 SQLite Archive、本地目录与 X 官方 <code>like.js</code>，在网页端永久标红已存推文</p>
          </div>
          <a class="btn primary" href="/api/twitter-sync/userscript.user.js">下载预配置油猴脚本 (.user.js)</a>
        </div>

        <div class="sm muted">
          ${tw.error
            ? esc(tw.error)
            : `当前已聚合 <strong>${tw.count ?? 0}</strong> 条推文 ID（SQLite Archive: ${s.archive_sqlite ?? 0} · 本地磁盘: ${s.disk ?? 0} · like.js: ${s.archive_js ?? 0} · 浏览器记录: ${s.browser ?? 0}）`}
        </div>

        <div class="field">
          <label for="tw-sync-token">油猴同步 Token（读写 <code>/api/archive/twitter-ids</code>）</label>
          <div class="input-with-btn">
            <input id="tw-sync-token" type="password" readonly value="${esc(tw.token || "")}">
            <button type="button" class="btn ghost sm" id="tw-token-toggle-btn">显示</button>
            <button type="button" class="btn ghost sm" id="tw-token-copy-btn">复制</button>
            <button type="button" class="btn ghost sm" id="tw-token-rotate-btn">重置</button>
          </div>
        </div>

        <div class="row-actions between">
          <div class="row-actions">
            <button type="button" class="btn sm" id="tw-scan-disk-btn">扫描 /gallery-dl/twitter 目录</button>
            <div class="file-picker-row">
              <input id="tw-likejs-file" type="file" accept=".js,.json,.txt" class="file-input">
              <button type="button" class="btn sm" id="tw-import-likejs-btn">导入 X 官方 like.js</button>
            </div>
          </div>
        </div>
      </section>

      <section class="card stack">
        <div class="card-head" style="margin-bottom:0;">
          <div>
            <h2>NAS 输入列表文件 (/data/inputs/*.txt)</h2>
            <p class="muted sm" style="margin:0.2rem 0 0;">可供定时任务（<code>-i</code>）或临时下载复用</p>
          </div>
        </div>

        <div class="file-picker-row">
          <input id="int-upload-input" type="file" accept=".txt,text/plain" class="file-input">
          <button type="button" class="btn primary sm" id="int-upload-btn">上传 .txt 到 NAS</button>
        </div>

        <div tabindex="0" role="region" aria-labelledby="int-files-cap" class="table-wrapper">
          <table class="data-table">
            <caption id="int-files-cap" class="visually-hidden">NAS 输入列表文件</caption>
            <thead><tr><th>文件名</th><th>有效 URL 数</th><th>大小</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              ${files.length
                ? files
                    .map(
                      (f) => `
                  <tr>
                    <td data-label="文件名"><code>${esc(f.name)}</code></td>
                    <td data-label="URL 数">${f.url_count}</td>
                    <td data-label="大小">${f.size} B</td>
                    <td data-label="更新时间">${fmtTime(f.updated_at)}</td>
                    <td data-label="操作"><button type="button" class="btn danger xs" data-del-input="${esc(f.name)}">删除</button></td>
                  </tr>`
                    )
                    .join("")
                : `<tr><td colspan="5" class="muted">暂无输入列表文件。</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  document.getElementById("tw-token-toggle-btn").addEventListener("click", (e) => {
    const el = document.getElementById("tw-sync-token");
    const show = el.type === "password";
    el.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "隐藏" : "显示";
  });

  document.getElementById("tw-token-copy-btn").addEventListener("click", async () => {
    const val = document.getElementById("tw-sync-token").value;
    if (!val) return;
    await navigator.clipboard.writeText(val);
    showToast("同步 Token 已复制");
  });

  document.getElementById("tw-token-rotate-btn").addEventListener("click", async () => {
    const ok = await confirmDialog("重置同步 Token", "重置后旧油猴脚本的 Token 将失效，需重新下载脚本或更新 Token，确认继续？", {
      confirmText: "重置",
      danger: true,
    });
    if (!ok) return;
    const res = await api("/api/twitter-sync/token/rotate", { method: "POST" });
    document.getElementById("tw-sync-token").value = res.token || "";
    showToast("已生成新的同步 Token");
  });

  document.getElementById("tw-scan-disk-btn").addEventListener("click", async () => {
    try {
      showToast("正在扫描 /gallery-dl/twitter 目录…");
      const res = await api("/api/twitter-sync/scan-disk", { method: "POST" });
      showToast(`扫描 ${res.scanned_files} 个文件，发现 ${res.found_ids} 个 ID，新增入库 ${res.inserted} 条`);
      await renderIntegrations(pane);
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  document.getElementById("tw-import-likejs-btn").addEventListener("click", async () => {
    const fi = document.getElementById("tw-likejs-file");
    const file = fi.files?.[0];
    if (!file) return showToast("请先选择 X 官方存档中的 like.js 文件", "danger");
    try {
      const content = await file.text();
      const res = await api("/api/twitter-sync/import-like-js", { method: "POST", body: { content } });
      showToast(`解析 ${res.parsed} 条推文 ID，新增入库 ${res.inserted} 条`);
      await renderIntegrations(pane);
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  document.getElementById("int-upload-btn").addEventListener("click", async () => {
    const fi = document.getElementById("int-upload-input");
    const file = fi.files?.[0];
    if (!file) return showToast("请先选择 .txt 文件", "danger");
    try {
      const content = await file.text();
      const res = await api("/api/inputs/upload", { method: "POST", body: { filename: file.name, content } });
      showToast(`已上传 ${res.file.name} (${res.file.url_count} 条 URL)`);
      await renderIntegrations(pane);
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  pane.querySelectorAll("[data-del-input]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.delInput;
      const ok = await confirmDialog("删除输入列表", `确定删除 /data/inputs/${name}？`, { confirmText: "删除", danger: true });
      if (!ok) return;
      try {
        await api(`/api/inputs/${encodeURIComponent(name)}`, { method: "DELETE" });
        showToast(`已删除 ${name}`);
        await renderIntegrations(pane);
      } catch (err) {
        showToast(err.message, "danger");
      }
    });
  });
}

async function renderAdvanced(pane) {
  const [raw, ov] = await Promise.all([api("/api/config/raw"), getConfigOverview(true)]);
  if (unmounted) return;
  const snaps = ov.snapshots || [];

  pane.innerHTML = `
    <div class="stack">
      <section class="card stack">
        <div class="card-head" style="margin-bottom:0;">
          <h2>原始 gallery-dl 基础 JSON 配置</h2>
          <span class="muted sm">保存时自动生成配置快照，并校验 JSON 格式</span>
        </div>
        <form id="set-raw-form" class="stack">
          <div class="field">
            <label for="rf-note">本次修改备注</label>
            <input id="rf-note" type="text" value="手动编辑 JSON 配置">
          </div>
          <div class="field">
            <label for="rf-json">基础配置 JSON</label>
            <textarea id="rf-json" rows="15" class="mono-area">${esc(raw.config_json || "{}")}</textarea>
          </div>
          <div><button type="submit" class="btn primary">校验并保存</button></div>
        </form>
      </section>

      <section class="card">
        <div class="card-head"><h2>配置变更历史快照</h2></div>
        <div tabindex="0" role="region" aria-labelledby="snaps-cap" class="table-wrapper">
          <table class="data-table">
            <caption id="snaps-cap" class="visually-hidden">配置快照列表</caption>
            <thead><tr><th>ID</th><th>时间</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>
              ${snaps.length
                ? snaps
                    .map(
                      (s) => `
                  <tr>
                    <td data-label="ID">#${s.id}</td>
                    <td data-label="时间">${fmtTime(s.created_at)}</td>
                    <td data-label="备注">${esc(s.note)}</td>
                    <td data-label="操作"><button type="button" class="btn sm" data-restore-snap="${s.id}">回滚至此版本</button></td>
                  </tr>`
                    )
                    .join("")
                : `<tr><td colspan="4" class="muted">暂无快照。</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  document.getElementById("set-raw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/config/raw", {
        method: "PUT",
        body: {
          note: document.getElementById("rf-note").value.trim(),
          config_json: document.getElementById("rf-json").value,
        },
      });
      invalidateSharedCache();
      showToast("JSON 配置已保存");
      await renderAdvanced(pane);
    } catch (err) {
      showToast(err.message, "danger");
    }
  });

  pane.querySelectorAll("[data-restore-snap]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.restoreSnap;
      const ok = await confirmDialog("回滚配置快照", `确定回滚配置到快照 #${id}？当前配置将自动留存新快照。`, {
        confirmText: "回滚",
      });
      if (!ok) return;
      try {
        await api(`/api/config/snapshots/${id}/restore`, { method: "POST" });
        invalidateSharedCache();
        showToast(`已回滚到快照 #${id}`);
        await renderAdvanced(pane);
      } catch (err) {
        showToast(err.message, "danger");
      }
    });
  });
}

export async function mount(el, params) {
  unmounted = false;
  hostEl = el;
  const requested = params.section || "general";
  currentSection = SECTIONS.some((s) => s.id === requested) ? requested : "general";

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>系统设置</h1>
        <p class="muted sm" style="margin:0.2rem 0 0;">全局网络与默认策略、外观、通知推送、安全与集成工具</p>
      </div>
    </div>

    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分区">
        ${SECTIONS.map(
          (s) =>
            `<a class="settings-nav-link" href="#/settings/${s.id}" ${s.id === currentSection ? 'aria-current="page"' : ""}>${esc(s.label)}</a>`
        ).join("")}
      </nav>
      <div id="settings-pane">
        <div class="notice muted">正在加载设置…</div>
      </div>
    </div>
  `;

  const pane = document.getElementById("settings-pane");
  if (currentSection === "general") await renderGeneral(pane);
  else if (currentSection === "notifications") await renderNotifications(pane);
  else if (currentSection === "security") await renderSecurity(pane);
  else if (currentSection === "integrations") await renderIntegrations(pane);
  else if (currentSection === "advanced") await renderAdvanced(pane);
}

export function onEvent(ev) {
  if (ev.type === "config_changed" && (currentSection === "general" || currentSection === "advanced")) {
    const pane = document.getElementById("settings-pane");
    if (pane && currentSection === "advanced") renderAdvanced(pane).catch(() => {});
  }
}

export function unmount() {
  unmounted = true;
  hostEl = null;
}
