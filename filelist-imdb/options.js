'use strict';

const FL = globalThis.FL;

const showCardInput = document.getElementById('showCard');
const showNameSearchInput = document.getElementById('showNameSearch');
const openInNewTabInput = document.getElementById('openInNewTab');
const showRatingsInput = document.getElementById('showRatings');
const showActorFilmsInput = document.getElementById('showActorFilms');
const showSubSearchInput = document.getElementById('showSubSearch');
const allCategoriesInput = document.getElementById('allCategories');
const cacheDaysSelect = document.getElementById('cacheDays');
const clearCacheButton = document.getElementById('clearCache');
const cacheStatus = document.getElementById('cacheStatus');
const sourcesEl = document.getElementById('sources');
const testAllButton = document.getElementById('testAllSources');
const sourcesStatus = document.getElementById('sourcesStatus');

const SOURCE_ROWS = [
  ['imdb', 'IMDb'],
  ['rt', 'Rotten Tomatoes'],
  ['mc', 'Metacritic'],
  ['lb', 'Letterboxd'],
  ['actors', 'Letterboxd — actori'],
  ['wiki', 'Wikipedia (postere)'],
];
const categoryListEl = document.getElementById('categoryList');
const langSelect = document.getElementById('lang');
const themeSelect = document.getElementById('theme');
const designSelect = document.getElementById('design');
const positionSelect = document.getElementById('position');
const statusEl = document.getElementById('status');
const sitesList = document.getElementById('sites');
const probeInput = document.getElementById('probe');
const probeLink = document.getElementById('probe-link');
const probeStatus = document.getElementById('probe-status');

let settings = Object.assign({}, FL.DEFAULT_SETTINGS);
let statusTimer = null;

function lang() {
  return settings.lang;
}

function sendMessage(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
          return;
        }
        resolve(response || { ok: false, error: { message: 'empty response' } });
      });
    } catch (error) {
      resolve({ ok: false, error: { message: String(error && error.message) } });
    }
  });
}

function setStatus(text, tone, target) {
  const node = target || statusEl;
  node.textContent = text;
  node.className = 'status' + (tone ? ' status--' + tone : '');
  if (node === statusEl) {
    if (statusTimer) clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => setStatus(''), 4000);
  }
}

function renderSites() {
  sitesList.replaceChildren();
  FL.SITES.forEach((site) => {
    const item = document.createElement('li');
    item.className = 'chip';
    item.textContent = site.label;
    sitesList.append(item);
  });
}

function translate() {
  FL.applyI18n(document, lang());
}

function buildSources() {
  sourcesEl.replaceChildren();
  for (const [id, label] of SOURCE_ROWS) {
    const row = document.createElement('div');
    row.className = 'source';
    row.dataset.source = id;
    const dot = document.createElement('span');
    dot.className = 'source__dot';
    const name = document.createElement('span');
    name.className = 'source__name';
    name.textContent = label;
    const result = document.createElement('span');
    result.className = 'source__result';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source__test';
    button.textContent = FL.t(lang(), 'options.testOne');
    button.addEventListener('click', () => runSource(id));
    row.append(dot, name, result, button);
    sourcesEl.append(row);
  }
}

function sourceRow(id) {
  return sourcesEl.querySelector('[data-source="' + id + '"]');
}

async function runSource(id) {
  const row = sourceRow(id);
  if (!row) return null;
  const result = row.querySelector('.source__result');
  row.classList.remove('source--ok', 'source--fail');
  row.classList.add('source--busy');
  result.textContent = FL.t(lang(), 'options.testing');

  const response = await sendMessage({ type: 'sources:test', source: id });
  row.classList.remove('source--busy');
  const data = response && response.ok && response.results ? response.results[id] : null;
  if (data && data.ok) {
    row.classList.add('source--ok');
    result.textContent = 'HTTP ' + data.code + ' · ' + data.detail + ' · ' + data.ms + ' ms';
  } else {
    row.classList.add('source--fail');
    result.textContent = data
      ? (data.code ? 'HTTP ' + data.code : FL.t(lang(), 'options.sourceFail')) + (data.detail ? ' · ' + data.detail : '')
      : FL.t(lang(), 'options.sourceFail');
  }
  return Boolean(data && data.ok);
}

async function runAllSources() {
  testAllButton.disabled = true;
  setStatus(FL.t(lang(), 'options.testing'), 'info', sourcesStatus);
  let okCount = 0;
  for (const [id] of SOURCE_ROWS) {
    const ok = await runSource(id);
    if (ok) okCount += 1;
  }
  testAllButton.disabled = false;
  const total = SOURCE_ROWS.length;
  setStatus(okCount + '/' + total, okCount === total ? 'ok' : 'err', sourcesStatus);
}

function readCategories() {
  const checked = [];
  for (const box of categoryListEl.querySelectorAll('input[type=checkbox]')) {
    if (box.checked) checked.push(box.value);
  }
  return checked;
}

function renderCategories(settings) {
  const chosen = Array.isArray(settings.categories) ? settings.categories : FL.DEFAULT_SETTINGS.categories;
  categoryListEl.replaceChildren();
  FL.FILELIST_CATEGORIES.forEach((name) => {
    const label = document.createElement('label');
    label.className = 'cat';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = name;
    box.checked = chosen.indexOf(name) !== -1;
    box.addEventListener('change', () => {
      save({ silent: true }).then(() => setStatus(FL.t(lang(), 'options.saved'), 'ok'));
    });
    const text = document.createElement('span');
    text.textContent = name;
    label.append(box, text);
    categoryListEl.append(label);
  });
  categoryListEl.classList.toggle('cats--disabled', settings.categoryMode === 'all');
}

function readForm() {
  return {
    showCard: showCardInput.checked,
    showNameSearch: showNameSearchInput.checked,
    openInNewTab: openInNewTabInput.checked,
    showRatings: showRatingsInput.checked,
    showActorFilms: showActorFilmsInput.checked,
    showSubSearch: showSubSearchInput.checked,
    categoryMode: allCategoriesInput.checked ? 'all' : 'selected',
    categories: readCategories(),
    cacheDays: Number(cacheDaysSelect.value) || FL.DEFAULT_SETTINGS.cacheDays,
    lang: langSelect.value,
    theme: themeSelect.value,
    design: designSelect.value,
    position: positionSelect.value,
  };
}

async function save(options) {
  settings = await FL.saveSettings(readForm());
  if (categoryListEl) categoryListEl.classList.toggle('cats--disabled', settings.categoryMode === 'all');
  if (!options || options.silent !== true) {
    setStatus(FL.t(settings.lang, 'options.saved'), 'ok');
  }
  return settings;
}

function updateProbe() {
  const raw = probeInput.value.trim();
  if (!raw) {
    probeLink.removeAttribute('href');
    probeLink.classList.add('is-disabled');
    setStatus('', '', probeStatus);
    return;
  }
  probeLink.href = FL.browseSearchUrl(raw);
  probeLink.classList.remove('is-disabled');
  const imdbId = FL.normalizeImdbId(raw);
  setStatus(
    imdbId ? FL.t(lang(), 'options.probeOk', { id: imdbId }) : FL.t(lang(), 'options.probeGeneric'),
    imdbId ? 'ok' : 'info',
    probeStatus,
  );
}

[showCardInput, showNameSearchInput, openInNewTabInput, showRatingsInput, showActorFilmsInput, showSubSearchInput, allCategoriesInput].forEach((input) => {
  input.addEventListener('change', () => save());
});

cacheDaysSelect.addEventListener('change', () => save());

clearCacheButton.addEventListener('click', async () => {
  clearCacheButton.disabled = true;
  const response = await sendMessage({ type: 'cache:clear' });
  clearCacheButton.disabled = false;
  if (response && response.ok) {
    setStatus(
      response.removed
        ? FL.t(lang(), 'options.cacheCleared', { n: response.removed })
        : FL.t(lang(), 'options.cacheEmpty'),
      'ok',
      cacheStatus,
    );
  } else {
    setStatus(FL.t(lang(), 'options.sourceFail'), 'err', cacheStatus);
  }
});

testAllButton.addEventListener('click', runAllSources);

themeSelect.addEventListener('change', () => save());
designSelect.addEventListener('change', () => save());
positionSelect.addEventListener('change', () => save());

langSelect.addEventListener('change', async () => {
  await save({ silent: true });
  translate();
  updateProbe();
  setStatus(FL.t(settings.lang, 'options.saved'), 'ok');
});

probeInput.addEventListener('input', updateProbe);

probeLink.addEventListener('click', (event) => {
  if (!probeLink.getAttribute('href')) event.preventDefault();
});

(async function init() {
  settings = await FL.getSettings();
  showCardInput.checked = settings.showCard;
  showNameSearchInput.checked = settings.showNameSearch;
  openInNewTabInput.checked = settings.openInNewTab;
  showRatingsInput.checked = settings.showRatings;
  showActorFilmsInput.checked = settings.showActorFilms;
  showSubSearchInput.checked = settings.showSubSearch;
  allCategoriesInput.checked = settings.categoryMode === 'all';
  renderCategories(settings);
  cacheDaysSelect.value = String(settings.cacheDays || FL.DEFAULT_SETTINGS.cacheDays);
  buildSources();
  langSelect.value = settings.lang;
  themeSelect.value = settings.theme;
  designSelect.value = settings.design;
  positionSelect.value = settings.position;
  translate();
  renderSites();
  updateProbe();
})();

