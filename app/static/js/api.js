/** Fetch API wrapper with CSRF header, 401 redirect, and light shared caches. */

const cache = {
  sitesHealth: null,
  configOverview: null,
};

export async function api(url, opts = {}) {
  const headers = { "X-Requested-With": "fetch", ...(opts.headers || {}) };
  const fetchOpts = { ...opts, headers };
  if (fetchOpts.body && typeof fetchOpts.body !== "string" && !(fetchOpts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(fetchOpts.body);
  }
  const res = await fetch(url, fetchOpts);
  if (res.status === 401) {
    location.replace("/login");
    throw new Error("未登录或会话已过期");
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export function invalidateSharedCache() {
  cache.sitesHealth = null;
  cache.configOverview = null;
}

export async function getSitesHealth(force = false) {
  if (!force && cache.sitesHealth) return cache.sitesHealth;
  try {
    const res = await api("/api/sites/health");
    cache.sitesHealth = res.sites || [];
  } catch {
    const ov = await getConfigOverview(force);
    cache.sitesHealth = (ov.sites || []).map((s) => ({
      ...s,
      configured: true,
      domains: [`${s.site}.com`, s.site],
      has_credentials: s.cookie_count > 0 || (s.auth_fields || []).length > 0,
      task_ids: [],
      task_names: [],
      health: "unknown",
    }));
  }
  return cache.sitesHealth;
}

export async function getConfigOverview(force = false) {
  if (!force && cache.configOverview) return cache.configOverview;
  const data = await api("/api/config/overview");
  cache.configOverview = data;
  return data;
}
