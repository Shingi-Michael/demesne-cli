/* Pages that remember: the Foundry page runtime. Demesne puts it in front of
   every page it shows, so a page can keep what you do in it and ask the
   chat's model a question of its own:

     await demesne.save("items", items)      keep any JSON value under a name
     await demesne.load("items", [])         read it back (or the fallback)
     await demesne.ask("What did I forget?") the model's answer, as text
     await demesne.pick({ accept: "image/*" }) a file you choose: { name, type, size, text | dataURL }

   What a page saves stays with the artifact in Demesne: it survives closing
   the page, reloads and new versions, and goes when the artifact is deleted.
   Inside Demesne the frame's origin is opaque (no localStorage), so saves go
   to foundry://data/<id> with the key Demesne gave this page. In an exported
   file they fall back to the browser's localStorage, and where neither works
   (the look window), to memory for as long as the page is open. */
(function () {
  var page = window.__demesnePage || null;
  delete window.__demesnePage;
  var memory = {}, cache = null, loading = null, queue = Promise.resolve();
  var MAX_BYTES = 256 * 1024;

  function inside() { return !!(page && page.id && page.key); }
  function call(what, body) {
    var url = "foundry://" + what + "/" + encodeURIComponent(page.id);
    // A plain-text POST with the page's key in the body: a simple request, so
    // no preflight from the frame's opaque origin.
    return fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(Object.assign({ page: page.key }, body || {})) })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data && data.error ? data.error : "Demesne could not do that (" + response.status + ")");
          return data;
        });
      });
  }
  function local() {
    try { var store = window.localStorage; store.getItem("x"); return store; } catch (error) { return null; }
  }
  var prefix = "demesne:" + (location.pathname || "page") + ":";
  function all() {
    if (cache) return Promise.resolve(cache);
    if (!inside()) {
      var store = local(), found = {};
      if (store) for (var index = 0; index < store.length; index++) {
        var name = store.key(index);
        if (name && name.indexOf(prefix) === 0) try { found[name.slice(prefix.length)] = JSON.parse(store.getItem(name)); } catch (error) {}
      }
      else found = memory;
      cache = found;
      return Promise.resolve(cache);
    }
    loading = loading || call("data").then(function (data) { cache = data && data.data && typeof data.data === "object" ? data.data : {}; return cache; })
      .catch(function (error) { loading = null; throw error; });
    return loading;
  }
  function checkKey(key) {
    if (typeof key !== "string" || !key || key.length > 200) throw new TypeError("demesne.save and demesne.load take a name: a string of up to 200 characters");
  }
  function save(key, value) {
    checkKey(key);
    var text = value === undefined ? undefined : JSON.stringify(value);
    if (text !== undefined && text.length > MAX_BYTES) return Promise.reject(new Error("That is too much to save; a page keeps up to 256 KB"));
    // Saves run in order, so the last one written is the one kept.
    var run = queue.then(function () { return all(); }).then(function (data) {
      if (text === undefined) delete data[key]; else data[key] = JSON.parse(text);
      // While Foundry plays a demo, what it types is not the person's: kept for the page, never saved.
      if (window.__demesneDemo && window.__demesneDemo.playing) return value;
      if (!inside()) {
        var store = local();
        if (store) try { if (text === undefined) store.removeItem(prefix + key); else store.setItem(prefix + key, text); } catch (error) {}
        return value;
      }
      return call("data", { name: key, value: text === undefined ? null : JSON.parse(text) }).then(function () { return value; });
    });
    queue = run.catch(function () {});
    return run;
  }
  function load(key, fallback) {
    checkKey(key);
    return queue.then(function () { return all(); }).then(function (data) {
      return Object.prototype.hasOwnProperty.call(data, key) ? JSON.parse(JSON.stringify(data[key])) : fallback;
    });
  }
  function ask(question) {
    var text = String(question == null ? "" : question).trim();
    if (!text) return Promise.reject(new TypeError("demesne.ask needs a question"));
    if (!inside()) return Promise.resolve("(The answer appears here when the page is open in Demesne.)");
    return call("ask", { question: text.slice(0, 8000) }).then(function (data) { return String(data.answer || ""); });
  }
  function pick(options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var input = document.createElement("input");
      input.type = "file";
      if (options.accept) input.accept = String(options.accept);
      input.style.cssText = "position:fixed;left:-9999px;opacity:0";
      document.body.appendChild(input);
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        if (file.size > 5 * 1024 * 1024) { reject(new Error("That file is bigger than 5 MB")); return; }
        var reader = new FileReader(), asText = /^text\/|json|xml|csv|javascript|markdown/.test(file.type) || /\.(txt|md|csv|json|tsv|xml|html?|js|ts|css)$/i.test(file.name);
        reader.onload = function () {
          var result = { name: file.name, type: file.type, size: file.size };
          if (asText) result.text = reader.result; else result.dataURL = reader.result;
          resolve(result);
        };
        reader.onerror = function () { reject(reader.error || new Error("Couldn't read that file")); };
        if (asText) reader.readAsText(file); else reader.readAsDataURL(file);
      }, { once: true });
      input.addEventListener("cancel", function () { input.remove(); resolve(null); }, { once: true });
      input.click();
    });
  }
  window.demesne = Object.assign(window.demesne || {}, { save: save, load: load, ask: ask, pick: pick });
})();
