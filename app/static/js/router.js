/** Hash-based client router with view lifecycle and accessibility focus transfer. */

const routes = [];
let activeRoute = null;
let activeView = null;
let mountSeq = 0;

export function registerRoute(pattern, loader) {
  const keys = [];
  const regexStr = pattern
    .replace(/\/+$/, "")
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    });
  const regex = new RegExp(`^${regexStr || "/"}$`);
  routes.push({ pattern, regex, keys, loader });
}

export function parseHash(hashStr = location.hash) {
  let path = (hashStr || "#/").replace(/^#/, "");
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1) path = path.replace(/\/+$/, "");

  for (const r of routes) {
    const m = path.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, path, params };
    }
  }
  return { route: routes[0], path: "/", params: {} };
}

export function navigate(hash) {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (location.hash === target) {
    return renderCurrentRoute();
  }
  location.hash = target;
}

export function getActiveView() {
  return activeView;
}

export function currentPath() {
  return activeRoute?.path || "/";
}

function updateNavActive(path) {
  let section = "activity";
  if (path.startsWith("/tasks")) section = "tasks";
  else if (path.startsWith("/runs")) section = "runs";
  else if (path.startsWith("/sites")) section = "sites";
  else if (path.startsWith("/settings")) section = "settings";

  document.querySelectorAll("[data-nav]").forEach((el) => {
    if (el.dataset.nav === section) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}

export async function renderCurrentRoute() {
  const seq = ++mountSeq;
  const container = document.getElementById("app-main");
  if (!container) return;

  const matched = parseHash(location.hash);
  activeRoute = matched;
  updateNavActive(matched.path);

  if (activeView?.unmount) {
    try {
      activeView.unmount();
    } catch {}
  }
  activeView = null;

  try {
    const mod = await matched.route.loader();
    if (seq !== mountSeq) return;
    activeView = mod;
    await mod.mount(container, matched.params);
    if (seq !== mountSeq) return;
    const h1 = container.querySelector("h1");
    if (h1) {
      h1.setAttribute("tabindex", "-1");
      h1.focus({ preventScroll: true });
    }
  } catch (err) {
    if (seq !== mountSeq) return;
    container.innerHTML = `<div class="notice danger">页面加载失败：${err?.message || err}</div>`;
  }
}

export function startRouter() {
  window.addEventListener("hashchange", () => {
    renderCurrentRoute();
  });
  if (!location.hash) {
    history.replaceState(null, "", "#/");
  }
  return renderCurrentRoute();
}
