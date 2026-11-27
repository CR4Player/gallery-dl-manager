/**
 * Minimal fetch wrapper matching gallery-dl-manager CSRF & auth conventions.
 */
async function request(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { ...(opts.headers || {}) };
  if (method !== "GET" && method !== "HEAD" && !opts.skipCsrf) {
    headers["X-Requested-With"] = "fetch";
  }

  let body = opts.body;
  if (body !== undefined && body !== null && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(body);
  }

  const res = await fetch(url, {
    ...opts,
    method,
    headers,
    body,
    credentials: "same-origin",
  });

  if (res.status === 401 && !opts.noAuthRedirect) {
    location.replace("/login");
    throw new Error("未登录或会话已过期");
  }

  const ct = res.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

  if (!res.ok) {
    const detail = (data && typeof data === "object" && (data.error || data.detail || data.message)) || (typeof data === "string" && data) || `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (url, opts) => request(url, { ...opts, method: "GET" }),
  post: (url, body, opts) => request(url, { ...opts, method: "POST", body }),
  put: (url, body, opts) => request(url, { ...opts, method: "PUT", body }),
  del: (url, body, opts) => request(url, { ...opts, method: "DELETE", body }),
};
