/* The Foundry motion runtime, served after anime.js as part of
   foundry://kit/anime.js. A page names a motion with
   demesne.motion("Arrive", timeline) and the pane beside the chat gains a
   line under the page to play, pause, scrub and slow it. The frame is
   sandboxed with its own origin, so the two talk by postMessage: the page
   reports its motions and their progress, the pane sends play, pause, seek,
   speed and restart. Nothing here reaches the page's data. */
(function () {
  var motions = [], byName = {}, parent = window.parent, current = null, lastTick = 0;
  function post(message) { if (parent && parent !== window) parent.postMessage(message, "*"); }
  function state(entry) {
    var tl = entry.timeline;
    return { name: entry.name, duration: tl.duration || 0, currentTime: tl.currentTime || 0, progress: tl.progress || 0, paused: !!tl.paused };
  }
  function announce() { post({ demesne: "motions", motions: motions.map(function (entry) { return { name: entry.name, duration: entry.timeline.duration || 0 }; }), current: current }); }
  function tick(entry, force) {
    var now = Date.now();
    if (!force && now - lastTick < 40) return;
    lastTick = now;
    post({ demesne: "motion", state: state(entry) });
  }
  function watch(entry) {
    var tl = entry.timeline, update = tl.onUpdate, done = tl.onComplete, begin = tl.onBegin;
    tl.onUpdate = function (self) { if (update) update(self); current = entry.name; tick(entry, false); };
    tl.onComplete = function (self) { if (done) done(self); tick(entry, true); };
    tl.onBegin = function (self) { if (begin) begin(self); current = entry.name; announce(); tick(entry, true); };
  }
  function motion(name, timeline) {
    if (typeof name !== "string" || !name || !timeline || typeof timeline.play !== "function") throw new Error("demesne.motion(name, timeline) needs a name and an anime.js timeline or animation");
    var entry = byName[name];
    if (entry) entry.timeline = timeline; else { entry = { name: name, timeline: timeline }; byName[name] = entry; motions.push(entry); }
    watch(entry);
    if (current === null || !timeline.paused) current = name;
    announce();
    tick(entry, true);
    return timeline;
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.demesne !== "motion" || typeof data.action !== "string") return;
    var entry = byName[typeof data.name === "string" ? data.name : current || ""];
    if (data.action === "speed") {
      var speed = typeof data.value === "number" && data.value > 0 ? data.value : 1;
      for (var i = 0; i < motions.length; i++) motions[i].timeline.speed = speed;
      return;
    }
    if (!entry) return;
    var tl = entry.timeline;
    current = entry.name;
    if (data.action === "play") { if (tl.completed) tl.restart(); else tl.play(); }
    else if (data.action === "pause") tl.pause();
    else if (data.action === "restart") tl.restart();
    else if (data.action === "seek") { tl.pause(); tl.seek(Math.max(0, Math.min(1, Number(data.value) || 0)) * (tl.duration || 0)); }
    announce();
    tick(entry, true);
  });
  window.demesne = Object.assign(window.demesne || {}, { motion: motion });
})();
