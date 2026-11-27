import { el } from "./util.js";
import { icon } from "./icons.js";

/** Fluent-style page header with title, subtitle and trailing commands. */
export function pageHead({ title, subtitle = "", eyebrow = "", actions = [], extra = null }) {
  return el(
    "header",
    { class: "page-head" },
    el(
      "div",
      { class: "page-head-text" },
      eyebrow
        ? el("div", { class: "page-eyebrow" }, icon("sparkle", 14), el("span", null, eyebrow))
        : null,
      el("h1", { class: "page-title" }, title),
      subtitle ? el("p", { class: "page-sub" }, subtitle) : null,
      extra
    ),
    actions.length ? el("div", { class: "page-actions" }, ...actions) : null
  );
}

/** Card header with optional icon, subtitle and actions. */
export function cardHead(title, { subtitle = "", iconName = "", actions = [] } = {}) {
  return el(
    "div",
    { class: "card-head" },
    el(
      "div",
      { class: "card-head-text" },
      iconName ? el("span", { class: "card-head-icon" }, icon(iconName, 16)) : null,
      el(
        "div",
        null,
        el("h2", { class: "fl-card-title" }, title),
        subtitle ? el("div", { class: "card-head-sub" }, subtitle) : null
      )
    ),
    actions.length ? el("div", { class: "row-actions" }, ...actions) : null
  );
}

/** KPI tile used across dashboard, task detail and run detail. */
export function statCard({ label, value, hint = "", tone = "", iconName = "activity", extra = null }) {
  return el(
    "div",
    { class: `fl-stat-card ${tone}`.trim() },
    el(
      "div",
      { class: "stat-top" },
      el("span", { class: `stat-icon ${tone}`.trim() }, icon(iconName, 15)),
      el("span", { class: "fl-stat-label" }, label)
    ),
    el("strong", null, value),
    hint || extra ? el("div", { class: "stat-hint" }, extra, hint) : null
  );
}

/** WinUI InfoBar. `body` may be a string or an array of nodes. */
export function infoBar({ tone = "", iconName = "", title = "", body = null, actions = [] }) {
  const iconNameResolved =
    iconName ||
    (tone === "danger" ? "x-circle" : tone === "warn" ? "alert" : tone === "info" ? "info" : "info");
  return el(
    "div",
    { class: `fl-infobar ${tone}`.trim() },
    el("span", { class: "infobar-icon" }, icon(iconNameResolved, 16)),
    el(
      "div",
      { class: "infobar-body" },
      title ? el("strong", null, title) : null,
      Array.isArray(body) ? body : body ? el("span", null, body) : null
    ),
    actions.length ? el("div", { class: "infobar-actions" }, ...actions) : null
  );
}

/** Centered empty state with a soft icon orb. */
export function emptyState(message, iconName = "inbox", title = "") {
  return el(
    "div",
    { class: "empty-state" },
    el("span", { class: "empty-icon" }, icon(iconName, 21)),
    title ? el("strong", null, title) : null,
    el("span", null, message)
  );
}

/** Simple breadcrumb: [{ label, href }] */
export function breadcrumb(items = []) {
  const nodes = [];
  items.forEach((item, index) => {
    if (index > 0) nodes.push(icon("chevron-right", 13));
    nodes.push(
      item.href
        ? el("a", { href: item.href }, index === 0 ? icon("arrow-left", 13) : null, el("span", null, item.label))
        : el("span", null, item.label)
    );
  });
  return el("nav", { class: "breadcrumb", "aria-label": "面包屑导航" }, ...nodes);
}

/** Labelled form field. */
export function field(labelText, control, { hint = "", extra = null, htmlFor = "" } = {}) {
  return el(
    "div",
    { class: "field" },
    el("label", htmlFor ? { htmlFor } : null, labelText),
    control,
    hint ? el("span", { class: "hint" }, hint) : null,
    extra
  );
}

/** Small square icon tile used in site cards. */
export function iconTile(name, tone = "") {
  return el("span", { class: `site-icon ${tone}`.trim() }, icon(name, 18));
}

/** Group of key/value rows. */
export function metaList(rows = []) {
  return el(
    "div",
    { class: "meta-list" },
    ...rows.map((row) =>
      el(
        "div",
        { class: "meta-row" },
        el("span", null, row.label),
        row.node ? el("span", null, row.node) : el("span", null, row.value)
      )
    )
  );
}
