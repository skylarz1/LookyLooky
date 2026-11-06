/**
 * Widget base class — the small part of the host app's widgets.js that the
 * camera wall uses.  A host stack with its own Widget can serve that file at
 * this path instead; camera-wall.js only calls super(options) and reads
 * this.options.
 */
export class Widget {
    constructor(options = {}) {
        this.options = options;
    }

    Reset() {}
    Resize() {}
    Dispose() {}
}

/** Replace an element's contents.  `selector` is a CSS selector ("#wall"). */
export function SetHtml(selector, html) {
    const el = typeof selector === "string" ? document.querySelector(selector) : selector;
    if (el != null) el.innerHTML = html;
}

if (typeof window !== "undefined" && typeof window.SetHtml !== "function") window.SetHtml = SetHtml;
