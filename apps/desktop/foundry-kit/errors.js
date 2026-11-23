/* Errors come back (Foundry, step 2 of the artifacts plan). Put first in front
 * of every page on the Foundry page: when the page throws while you use it,
 * its promise is refused with nobody listening, or a script it needs fails
 * to load, the Foundry page is told, and says so under the mockup with one
 * press to send it to the chat. Like Claude artifacts' "Try fixing".
 * Each load starts clean; the same error is told once; at most a few. */
(function () {
  if (window.__demesneErrors) return;
  window.__demesneErrors = true;
  var told = {}, count = 0, MAX = 5;
  function tell(message) { message.demesne = "error"; try { parent.postMessage(message, "*"); } catch (error) {} }
  function clip(text, size) { text = String(text == null ? "" : text).replace(/\s+/g, " ").trim(); return text.length > size ? text.slice(0, size - 1) + "…" : text; }
  function report(message, line, stack) {
    message = clip(message, 300);
    if (!message || told[message] || count >= MAX) return;
    told[message] = true; count++;
    tell({ action: "error", message: message, line: line > 0 ? line : 0, stack: clip(stack, 600) });
  }
  tell({ action: "fresh" });
  window.addEventListener("error", function (event) {
    var target = event.target;
    // A script or stylesheet that didn't load (a blocked host, a wrong address).
    if (target && target !== window && (target.tagName === "SCRIPT" || target.tagName === "LINK")) {
      report("Couldn't load " + (target.src || target.href || "a " + target.tagName.toLowerCase()), 0, "");
      return;
    }
    var error = event.error;
    // No line number: Foundry's own scripts sit in front of the page, so the browser's count is off by them.
    report((error && error.message) || event.message || "Script error", 0, error && error.stack);
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    report("Unhandled promise: " + ((reason && reason.message) || String(reason)), 0, reason && reason.stack);
  });
})();
