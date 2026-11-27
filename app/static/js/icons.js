/**
 * Inline Fluent-style line icons (24x24 grid, 1.6 stroke).
 * Kept as a tiny zero-dependency module so every view shares one icon language.
 */
const PATHS = {
  grid: '<rect x="3.25" y="3.25" width="7.5" height="7.5" rx="1.6"/><rect x="13.25" y="3.25" width="7.5" height="7.5" rx="1.6"/><rect x="3.25" y="13.25" width="7.5" height="7.5" rx="1.6"/><rect x="13.25" y="13.25" width="7.5" height="7.5" rx="1.6"/>',
  calendar:
    '<rect x="3.25" y="5" width="17.5" height="16" rx="2.2"/><path d="M8 2.75V7M16 2.75V7M3.25 10.5h17.5"/><path d="M7.5 14.5h2M14.5 14.5h2M7.5 17.75h2M14.5 17.75h2"/>',
  terminal:
    '<rect x="2.75" y="4" width="18.5" height="16" rx="2.4"/><path d="m6.75 9.25 3 2.75-3 2.75M12.75 15.25h4.5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3.1 12h17.8"/><path d="M12 3a14.4 14.4 0 0 1 0 18 14.4 14.4 0 0 1 0-18Z"/>',
  settings:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.6a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 1 1-2.9 2.9l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55v.17a2.05 2.05 0 0 1-4.1 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2.05 2.05 0 1 1-2.9-2.9l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03h-.17a2.05 2.05 0 0 1 0-4.1h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2.05 2.05 0 1 1 2.9-2.9l.06.06a1.7 1.7 0 0 0 1.87.34H9.4a1.7 1.7 0 0 0 1.03-1.55v-.17a2.05 2.05 0 0 1 4.1 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.05 2.05 0 1 1 2.9 2.9l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1.03h.17a2.05 2.05 0 0 1 0 4.1h-.09a1.7 1.7 0 0 0-1.55 1.03Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  refresh: '<path d="M20.4 12a8.4 8.4 0 1 1-2.46-5.94"/><path d="M20.5 4.5v5.2h-5.2"/>',
  play: '<path d="M8.5 5.6v12.8L18.6 12 8.5 5.6Z"/>',
  pause: '<rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/>',
  edit: '<path d="M12.5 20.25H21"/><path d="M16.7 3.9a2.2 2.2 0 0 1 3.1 3.1L7.3 19.5l-4.1 1 1-4.1L16.7 3.9Z"/>',
  trash:
    '<path d="M3.75 6.25h16.5M9 6.25V4.4a1.4 1.4 0 0 1 1.4-1.4h3.2A1.4 1.4 0 0 1 15 4.4v1.85"/><path d="M18.6 6.25 17.8 19a2 2 0 0 1-2 1.85H8.2a2 2 0 0 1-2-1.85L5.4 6.25"/><path d="M10.1 10.5v6M13.9 10.5v6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  bell: '<path d="M18 8.4a6 6 0 1 0-12 0c0 7-2.8 8.6-2.8 8.6h17.6S18 15.4 18 8.4Z"/><path d="M13.7 20.6a2 2 0 0 1-3.4 0"/>',
  search: '<circle cx="10.8" cy="10.8" r="7"/><path d="m20.5 20.5-4.9-4.9"/>',
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'chevron-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  'chevron-down': '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  'arrow-left': '<path d="M20 12H4.5M10.5 5.5 4 12l6.5 6.5"/>',
  'arrow-right': '<path d="M4 12h15.5M13.5 5.5 20 12l-6.5 6.5"/>',
  sun: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.5v2M12 19.5v2M4.7 4.7l1.4 1.4M17.9 17.9l1.4 1.4M2.5 12h2M19.5 12h2M4.7 19.3l1.4-1.4M17.9 6.1l1.4-1.4"/>',
  moon: '<path d="M20.2 14.4A8.6 8.6 0 0 1 9.6 3.8 8.6 8.6 0 1 0 20.2 14.4Z"/>',
  monitor:
    '<rect x="2.75" y="3.75" width="18.5" height="12.5" rx="2"/><path d="M8.5 20.25h7M12 16.25v4"/>',
  logout:
    '<path d="M14.5 3.5h4a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-4"/><path d="m9.5 16.5 4.5-4.5-4.5-4.5M14 12H3.5"/>',
  alert:
    '<path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.2M12 16.9h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.9h.01"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.7 2.7L16.3 9"/>',
  'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  check: '<path d="m5 12.5 4.6 4.6L19.2 7.5"/>',
  download: '<path d="M12 3.5v11.5"/><path d="m6.8 10.3 5.2 5.2 5.2-5.2"/><path d="M4.5 20.5h15"/>',
  upload: '<path d="M12 20.5V9"/><path d="m6.8 13.7 5.2-5.2 5.2 5.2"/><path d="M4.5 3.5h15"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  external: '<path d="M13.5 4.5h6v6"/><path d="m19.5 4.5-8.25 8.25"/><path d="M18.5 14.5v4a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4"/>',
  folder: '<path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.4l2 2.4h7.2a2.2 2.2 0 0 1 2.2 2.2v7.2a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2Z"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m11 12.6 8.4-8.4M16.4 7.2l2.2 2.2M14.1 9.5l2.2 2.2"/>',
  database:
    '<ellipse cx="12" cy="5.75" rx="8.2" ry="3.25"/><path d="M3.8 5.75v12.5c0 1.8 3.67 3.25 8.2 3.25s8.2-1.45 8.2-3.25V5.75"/><path d="M3.8 12c0 1.8 3.67 3.25 8.2 3.25s8.2-1.45 8.2-3.25"/>',
  activity: '<path d="M3 12.5h4l2.6-7 4.2 13 2.6-6h4.6"/>',
  server:
    '<rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M7 7.25h.01M7 16.75h.01M11 7.25h4M11 16.75h4"/>',
  shield: '<path d="M12 3 4.8 5.8v5.4c0 4.6 3.1 7.9 7.2 9.8 4.1-1.9 7.2-5.2 7.2-9.8V5.8Z"/><path d="m8.9 12 2.2 2.2 4-4.4"/>',
  save: '<path d="M4.5 4.5h12.2L20 7.8v11.7H4.5Z"/><path d="M8 4.5v5h7v-5M8 19.5v-5.8h8v5.8"/>',
  zap: '<path d="M13.2 2.8 4.6 13.4h6.2l-.9 7.8 8.6-10.6h-6.2l.9-7.8Z"/>',
  filter: '<path d="M3.5 5.5h17l-6.6 7.8v5.9l-3.8 2v-7.9Z"/>',
  'file-text':
    '<path d="M14 3.5H6.8a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2V8.7Z"/><path d="M14 3.5v5.2h5.2M8.6 12.5h6.8M8.6 16h6.8"/>',
  more: '<circle cx="5.5" cy="12" r="1.35"/><circle cx="12" cy="12" r="1.35"/><circle cx="18.5" cy="12" r="1.35"/>',
  inbox: '<path d="M4 4.5h16l2 9.5v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4Z"/><path d="M2.2 14h5.1l1.5 2.4h6.4l1.5-2.4h5.1"/>',
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.6 13 4.6a4.3 4.3 0 0 1 6.1 6.1l-2 2"/><path d="m13 17.4-2 2a4.3 4.3 0 0 1-6.1-6.1l2-2"/>',
  image:
    '<rect x="3.25" y="4.5" width="17.5" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4.5 17 4.6-4.6 3.4 3.4 2.6-2.6 4.4 4.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.3 2.1"/>',
  sparkle:
    '<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 11 10.1 9 12 3.5Z"/><path d="M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14.3v2.4"/>',
  eye: '<path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="m3 3 18 18"/><path d="M10.6 6.1A10.9 10.9 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3.4 3.9M6.2 7.7A16.3 16.3 0 0 0 2.5 12S6 18 12 18a10 10 0 0 0 4.3-1"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(name, size = 16, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  svg.innerHTML = PATHS[name] || PATHS.info;
  return svg;
}

export function iconMarkup(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || PATHS.info}</svg>`;
}
