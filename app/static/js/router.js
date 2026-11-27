export function parseHash(rawHash = location.hash) {
  let clean = (rawHash || "#activity").replace(/^#/, "");
  if (clean.startsWith("/")) clean = clean.slice(1);
  const [pathPart, queryPart] = clean.split("?");
  const segs = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(queryPart || ""));

  if (!segs.length || segs[0] === "activity") {
    return { view: "activity", nav: "activity", params };
  }
  if (segs[0] === "tasks") {
    return { view: "tasks", nav: "tasks", params };
  }
  if (segs[0] === "task" && segs[1]) {
    return { view: "task-detail", nav: "tasks", id: segs[1], params };
  }
  if (segs[0] === "runs") {
    return { view: "runs", nav: "runs", id: segs[1] || null, params };
  }
  if (segs[0] === "sites") {
    return { view: "sites", nav: "sites", params };
  }
  if (segs[0] === "site" && segs[1]) {
    return { view: "site-detail", nav: "sites", site: segs[1], params };
  }
  if (segs[0] === "settings") {
    return { view: "settings", nav: "settings", tab: segs[1] || "general", params };
  }
  return { view: "activity", nav: "activity", params };
}

export function navigate(targetHash) {
  const h = targetHash.startsWith("#") ? targetHash : `#${targetHash}`;
  if (location.hash === h) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = h;
  }
}

export function startRouter(onRoute) {
  const handle = () => onRoute(parseHash(location.hash));
  window.addEventListener("hashchange", handle);
  handle();
  return () => window.removeEventListener("hashchange", handle);
}
