import { el } from "../util.js";

/**
 * Inherit-vs-Override control for tri-state task / download configuration fields.
 * Value === null | undefined | "" (when allowEmptyFalse) means inherit global/site default.
 */
export function createOverrideField({
  label,
  value = null,
  inheritedText = "全局/站点默认",
  inheritedSource = "继承默认",
  type = "text", // "text" | "number" | "select" | "boolean"
  options = [],
  placeholder = "",
  defaultCustomValue = "",
  min = undefined,
  step = undefined,
  onChange = () => {},
}) {
  let current = value === "" ? null : value;
  const wrap = el("div", { class: "ov-wrap" });

  const render = () => {
    wrap.innerHTML = "";
    const isCustom = current !== null && current !== undefined;

    const head = el(
      "div",
      { class: "ov-head" },
      el("span", { class: "ov-label" }, label),
      isCustom
        ? el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle xs",
              onClick: () => {
                current = null;
                render();
                onChange(null);
              },
            },
            "恢复继承"
          )
        : el(
            "button",
            {
              type: "button",
              class: "fl-btn subtle xs",
              onClick: () => {
                current = defaultCustomValue !== undefined ? defaultCustomValue : type === "boolean" ? true : "";
                render();
                onChange(current);
              },
            },
            "覆盖"
          )
    );

    wrap.appendChild(head);

    if (!isCustom) {
      wrap.appendChild(
        el(
          "div",
          { class: "ov-inherited-row" },
          el(
            "div",
            { class: "ov-inherited-val" },
            el("span", { class: "fl-badge neutral" }, inheritedSource),
            el("span", { class: "ov-inherited-text", title: String(inheritedText) }, String(inheritedText))
          )
        )
      );
      return;
    }

    if (type === "select") {
      const sel = el(
        "select",
        {
          onChange: (e) => {
            current = e.target.value;
            onChange(current);
          },
        },
        ...options.map((opt) =>
          el("option", { value: opt.value, selected: String(opt.value) === String(current) }, opt.label)
        )
      );
      wrap.appendChild(sel);
    } else if (type === "boolean") {
      const sel = el(
        "select",
        {
          onChange: (e) => {
            current = e.target.value === "true";
            onChange(current);
          },
        },
        el("option", { value: "true", selected: current === true }, "强制开启"),
        el("option", { value: "false", selected: current === false }, "强制关闭")
      );
      wrap.appendChild(sel);
    } else {
      const inp = el("input", {
        type: type === "number" ? "number" : "text",
        value: current ?? "",
        placeholder,
        min,
        step,
        onInput: (e) => {
          const raw = e.target.value;
          current = type === "number" ? (raw === "" ? "" : Number(raw)) : raw;
          onChange(current);
        },
      });
      wrap.appendChild(inp);
    }
  };

  render();

  return {
    el: wrap,
    getValue: () => current,
    setValue: (v) => {
      current = v === "" ? null : v;
      render();
    },
  };
}
