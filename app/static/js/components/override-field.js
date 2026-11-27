import { esc } from "../util.js";

/**
 * Light-DOM custom element for displaying inherited configuration values
 * with explicit one-click override and restore-to-inherited controls.
 */
class OverrideField extends HTMLElement {
  constructor() {
    super();
    this._overriding = false;
    this._value = "";
    this._inherited = "";
    this._source = "默认";
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered) {
      this._inherited = this.getAttribute("inherited") || "";
      this._source = this.getAttribute("source") || "默认";
      this._value = this.getAttribute("value") || "";
      this._overriding = Boolean(this._value);
      this._render();
      this._rendered = true;
    }
  }

  get value() {
    return this._overriding ? this._value : "";
  }

  set value(val) {
    this._value = String(val ?? "");
    this._overriding = Boolean(this._value);
    if (this._rendered) this._syncUI();
  }

  setInherited(inheritedText, sourceText) {
    this._inherited = String(inheritedText ?? "");
    this._source = String(sourceText ?? "默认");
    if (this._rendered) {
      const valEl = this.querySelector(".ov-inherited-text");
      const srcEl = this.querySelector(".ov-source-tag");
      if (valEl) valEl.textContent = this._inherited || "(未设置)";
      if (srcEl) srcEl.textContent = `来自 ${this._source}`;
    }
  }

  _render() {
    const label = this.getAttribute("label") || "";
    const placeholder = this.getAttribute("placeholder") || "";
    const hint = this.getAttribute("hint") || "";
    const inputId = `ov-${Math.random().toString(36).slice(2, 9)}`;

    this.innerHTML = `
      <div class="ov-wrap">
        <div class="ov-head">
          <label class="ov-label" for="${inputId}">${esc(label)}</label>
          <span class="ov-source-tag ${this._overriding ? "is-task" : ""}">
            ${this._overriding ? "已覆盖" : `来自 ${esc(this._source)}`}
          </span>
        </div>
        <div class="ov-inherited-row ${this._overriding ? "hidden" : ""}">
          <span class="ov-inherited-val">
            <span>继承：</span>
            <code class="ov-inherited-text">${esc(this._inherited || "(未设置)")}</code>
          </span>
          <button type="button" class="btn ghost xs ov-override-btn">覆盖</button>
        </div>
        <div class="ov-editor ${this._overriding ? "" : "hidden"}">
          <div class="input-with-btn">
            <input id="${inputId}" type="text" class="ov-input" value="${esc(this._value)}" placeholder="${esc(placeholder)}">
            <button type="button" class="btn ghost xs ov-restore-btn">恢复继承</button>
          </div>
        </div>
        ${hint ? `<div class="hint">${esc(hint)}</div>` : ""}
      </div>
    `;

    const inputEl = this.querySelector(".ov-input");
    const overrideBtn = this.querySelector(".ov-override-btn");
    const restoreBtn = this.querySelector(".ov-restore-btn");

    overrideBtn.addEventListener("click", () => {
      this._overriding = true;
      this._syncUI();
      inputEl.focus();
    });

    restoreBtn.addEventListener("click", () => {
      this._value = "";
      this._overriding = false;
      inputEl.value = "";
      this._syncUI();
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });

    inputEl.addEventListener("input", () => {
      this._value = inputEl.value;
      this.dispatchEvent(new Event("input", { bubbles: true }));
    });

    inputEl.addEventListener("change", () => {
      this._value = inputEl.value;
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  _syncUI() {
    const inhRow = this.querySelector(".ov-inherited-row");
    const edRow = this.querySelector(".ov-editor");
    const tag = this.querySelector(".ov-source-tag");
    const inputEl = this.querySelector(".ov-input");
    if (!inhRow || !edRow || !tag || !inputEl) return;

    inhRow.classList.toggle("hidden", this._overriding);
    edRow.classList.toggle("hidden", !this._overriding);
    tag.classList.toggle("is-task", this._overriding);
    tag.textContent = this._overriding ? "已覆盖" : `来自 ${this._source}`;
    if (inputEl.value !== this._value) inputEl.value = this._value;
  }
}

if (!customElements.get("override-field")) {
  customElements.define("override-field", OverrideField);
}
