/// Writes that change nothing still cost something: the window redraws every
/// part on each update, and setting `hidden`, a class or an attribute to the
/// value it already has queues a mutation and can send the browser back to
/// work out styles. On a slow CPU (Low Power Mode) that was most of a
/// redraw. These setters skip a write when the value is already there.
/// (`src`, `href` and `value` are left alone: writing them again can mean
/// "load it again".)
const LOADS = new Set(["src", "href", "value", "srcdoc", "data"]);

export function quietDom(): void {
  const proto = HTMLElement.prototype as any;
  if (proto.__quiet) return;
  proto.__quiet = true;
  const hidden = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden")!;
  Object.defineProperty(HTMLElement.prototype, "hidden", {
    ...hidden,
    set(this: HTMLElement, value: unknown) {
      if (typeof value === "boolean" && this.hasAttribute("hidden") === value && (!value || this.getAttribute("hidden") === "")) return;
      hidden.set!.call(this, value);
    },
  });
  const title = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "title")!;
  Object.defineProperty(HTMLElement.prototype, "title", {
    ...title,
    set(this: HTMLElement, value: unknown) { if (this.getAttribute("title") !== String(value)) title.set!.call(this, value); },
  });
  const className = Object.getOwnPropertyDescriptor(Element.prototype, "className")!;
  Object.defineProperty(Element.prototype, "className", {
    ...className,
    set(this: Element, value: unknown) { if (this.getAttribute("class") !== String(value)) className.set!.call(this, value); },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (!LOADS.has(name.toLowerCase()) && this.getAttribute(name) === String(value)) return;
    setAttribute.call(this, name, value);
  };
}
