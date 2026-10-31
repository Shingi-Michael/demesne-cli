/* Pick an option (pass 115): a Foundry page that shows options marks each
   with data-option="B · Joined". Hovering one shows a small Pick button at
   its corner; a click tells the pane, which sends "I pick B · Joined" to the
   chat. Served as foundry://kit/pick.js to pages that mark options. The
   frame is sandboxed with its own origin, so it only posts the option's
   words to the pane; nothing else leaves the page. */
(function () {
  var parent = window.parent;
  if (!parent || parent === window) return;
  var button = document.createElement("button"), target = null, hideTimer = 0;
  button.type = "button";
  button.className = "demesne-pick";
  button.setAttribute("aria-hidden", "true");
  button.tabIndex = -1;
  button.style.cssText = "position:fixed;z-index:2147483647;display:none;margin:0;padding:3px 10px;border-radius:999px;border:1px solid var(--hair,rgba(0,0,0,.12));"
    + "background:var(--ink,#1d1d1f);color:var(--paper,#fff);font:500 12px/18px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18)";
  function label(element) {
    var named = element.getAttribute("data-option");
    if (named && named.trim()) return named.trim();
    var heading = element.querySelector("h1,h2,h3,h4,b,strong");
    return ((heading || element).textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  }
  function place() {
    if (!target || !target.isConnected) { hide(); return; }
    var box = target.getBoundingClientRect(), width = button.offsetWidth || 60;
    button.style.top = Math.max(4, box.top + 8) + "px";
    button.style.left = Math.max(4, Math.min(window.innerWidth - width - 4, box.right - width - 8)) + "px";
  }
  function show(element) {
    clearTimeout(hideTimer);
    target = element;
    var words = label(element), letter = words.split(/[\s·:.-]/)[0];
    button.textContent = letter && letter.length <= 2 ? "Pick " + letter : "Pick";
    button.title = "Send “I pick " + words + "” to the chat";
    button.removeAttribute("aria-hidden");
    button.tabIndex = 0;
    if (!button.isConnected) document.body.appendChild(button);
    button.style.display = "block";
    place();
  }
  function hide() {
    target = null;
    button.style.display = "none";
    button.setAttribute("aria-hidden", "true");
    button.tabIndex = -1;
  }
  document.addEventListener("mouseover", function (event) {
    if (event.target === button) { clearTimeout(hideTimer); return; }
    var element = event.target && event.target.closest ? event.target.closest("[data-option]") : null;
    if (element) show(element);
    else if (target) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 160); }
  });
  document.addEventListener("mouseleave", function () { hideTimer = setTimeout(hide, 160); });
  // Keyboard: focusing inside an option offers its Pick too.
  document.addEventListener("focusin", function (event) {
    if (event.target === button) return;
    var element = event.target && event.target.closest ? event.target.closest("[data-option]") : null;
    if (element) show(element);
  });
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!target) return;
    parent.postMessage({ demesne: "pick", option: label(target) }, "*");
    button.textContent = "Sent";
    setTimeout(hide, 700);
  });
})();
