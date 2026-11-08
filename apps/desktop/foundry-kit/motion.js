/* Served after anime.js as part of foundry://kit/anime.js. Earlier pages
   named their motions with demesne.motion("Arrive", timeline) for a play
   line beside the chat; Foundry is now only for looking, so the call just
   hands the timeline back and the page plays as written. */
(function () {
  function motion(name, timeline) { return timeline; }
  window.demesne = Object.assign(window.demesne || {}, { motion: motion });
})();
