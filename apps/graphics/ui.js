const draft = document.querySelector('textarea');
const form = document.querySelector('form');
const tokens = document.querySelector('#tokens');
let noticeTimer;
function changed() {
  tokens.textContent = `~${Math.ceil(new TextEncoder().encode(draft.value).length / 3)} tok`;
  draft.style.height = '22px';
  draft.style.height = `${Math.min(132, draft.scrollHeight)}px`;
}
function notice(text) {
  const element = document.querySelector('#notice');
  element.textContent = text; element.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { element.hidden = true; }, 4000);
}
draft.addEventListener('input', changed);
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.operation').forEach(item => item.classList.toggle('selected', item === button));
  draft.value = button.dataset.prompt; draft.focus(); changed();
}));
document.querySelectorAll('[data-insert]').forEach(button => button.addEventListener('click', () => {
  draft.setRangeText(button.dataset.insert, draft.selectionStart, draft.selectionEnd, 'end'); draft.focus(); changed();
}));
document.querySelector('#newline').addEventListener('click', () => {
  draft.setRangeText('\n', draft.selectionStart, draft.selectionEnd, 'end'); draft.focus(); changed();
});
form.addEventListener('submit', event => { event.preventDefault(); notice('Rendering prototype: your draft stays here. No agent request is sent.'); });
document.querySelectorAll('[data-note]').forEach(button => button.addEventListener('click', () => notice(`${button.dataset.note} · design fixture, not connected to a session.`)));
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && event.target === draft) { event.preventDefault(); form.requestSubmit(); }
  if (event.key === 'Escape') document.querySelector('#notice').hidden = true;
});
// Deliberately do not autofocus: the initial frame matches Figma, then click or Tab focuses the draft.
