'use strict';

const FL = globalThis.FL;

const quickForm = document.getElementById('quick-search');
const quickInput = document.getElementById('q');
const hintEl = document.getElementById('hint');

let settings = Object.assign({}, FL.DEFAULT_SETTINGS);

function updateHint() {
  const raw = quickInput.value.trim();
  if (!raw) {
    hintEl.textContent = FL.t(settings.lang, 'popup.hintEmpty');
    return;
  }
  const imdbId = FL.normalizeImdbId(raw);
  hintEl.textContent = imdbId
    ? FL.t(settings.lang, 'popup.hintId', { id: imdbId })
    : FL.t(settings.lang, 'popup.hintText', { q: raw });
}

quickForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = quickInput.value.trim();
  if (!raw) {
    quickInput.focus();
    return;
  }
  openUrl(FL.browseSearchUrl(raw));
});

quickInput.addEventListener('input', updateHint);

document.getElementById('open-site').addEventListener('click', () => {
  openUrl(FL.SITE_URL);
});

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

function openUrl(url) {
  const safe = FL.safeUrl(url);
  if (!safe) return;
  if (settings.openInNewTab) {
    chrome.tabs.create({ url: safe });
    window.close();
  } else {
    chrome.tabs.update({ url: safe });
  }
}

(async function init() {
  settings = await FL.getSettings();
  FL.applyI18n(document, settings.lang);
  updateHint();
  quickInput.focus();
})();
