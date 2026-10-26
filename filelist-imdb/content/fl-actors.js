/**
 * Lupa de lângă actorii de pe pagina FileList: deschide un panou cu filmele
 * actorului (postere), fiecare ducând pe FileList sau pe IMDb.
 * Surse: Wikidata (lista de filme + IMDb ID) și Wikipedia (postere).
 */
(function () {
  'use strict';

  const FL = globalThis.FL;
  if (!FL || globalThis.__flActors) return;
  globalThis.__flActors = true;

  const CAST_IMG = 'img[src*="image.tmdb.org/t/p/w132_and_h132"]';

  let settings = null;
  let overlay = null;
  let requestId = 0;

  /* ----------------------------- utilitare ----------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
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

  function t(key, vars) {
    return FL.t(settings ? settings.lang : 'ro', key, vars);
  }

  function magnifierIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'fl-actor-mag__svg');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '10');
    circle.setAttribute('cy', '10');
    circle.setAttribute('r', '6.5');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2.4');
    const handle = document.createElementNS(ns, 'line');
    handle.setAttribute('x1', '15');
    handle.setAttribute('y1', '15');
    handle.setAttribute('x2', '21');
    handle.setAttribute('y2', '21');
    handle.setAttribute('stroke', 'currentColor');
    handle.setAttribute('stroke-width', '2.6');
    handle.setAttribute('stroke-linecap', 'round');
    svg.append(circle, handle);
    return svg;
  }

  /* --------------------------- actorii din pagină ---------------------- */

  function actorName(cell) {
    const bold = cell.querySelector('b');
    if (!bold) return '';
    const first = bold.firstChild;
    const text = first && first.nodeType === 3 ? first.textContent : bold.textContent;
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function castCells() {
    const found = [];
    const seen = new Set();
    for (const img of document.querySelectorAll(CAST_IMG)) {
      const cell = img.closest('div');
      if (!cell || seen.has(cell)) continue;
      const name = actorName(cell);
      if (!name || name.length < 2 || name.length > 70) continue;
      seen.add(cell);
      found.push({ cell, name });
    }
    return found;
  }

  function attachMagnifiers() {
    if (!settings || !settings.showActorFilms) return;
    if (!document.body) return;
    if (!FL.isCategoryAllowed(settings, FL.detectFilelistCategory(document))) return;
    for (const { cell, name } of castCells()) {
      if (cell.querySelector('.fl-actor-mag')) continue;
      const computed = window.getComputedStyle(cell).position;
      if (computed === 'static') cell.style.position = 'relative';
      const button = el('button', 'fl-actor-mag');
      button.type = 'button';
      button.title = t('actors.openActor', { name });
      button.setAttribute('aria-label', t('actors.openActor', { name }));
      button.append(magnifierIcon());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanel(name);
      });
      cell.append(button);
    }
  }

  /* ------------------------------- panoul ------------------------------ */

  function buildOverlay() {
    const root = el('div', 'fl-actor-overlay');
    root.hidden = true;
    root.addEventListener('click', (event) => {
      if (event.target === root) closePanel();
    });

    const panel = el('div', 'fl-actor-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const head = el('div', 'fl-actor-head');
    const title = el('h3', 'fl-actor-title', '');
    title.dataset.role = 'title';
    const close = el('button', 'fl-actor-close', '✕');
    close.type = 'button';
    close.title = t('actors.close');
    close.setAttribute('aria-label', t('actors.close'));
    close.addEventListener('click', () => closePanel());
    head.append(title, close);
    panel.append(head);

    const body = el('div', 'fl-actor-body');
    body.dataset.role = 'body';
    panel.append(body);

    root.append(panel);
    document.body.append(root);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && overlay && !overlay.hidden) closePanel();
    });

    return root;
  }

  function closePanel() {
    if (overlay) overlay.hidden = true;
  }

  function setBody(nodes) {
    const body = overlay ? overlay.querySelector('[data-role="body"]') : null;
    if (!body) return;
    body.replaceChildren();
    (Array.isArray(nodes) ? nodes : [nodes]).forEach((node) => body.append(node));
  }

  function card(film) {
    const wrapper = el('div', 'fl-actor-card');

    const main = el('a', 'fl-actor-card__main');
    const searchUrl = FL.safeUrl(film.filelistUrl);
    if (searchUrl) {
      main.href = searchUrl;
      if (!settings || settings.openInNewTab) {
        main.target = '_blank';
        main.rel = 'noopener noreferrer';
      }
    }
    main.title = t('actors.search') + ': ' + film.title;

    if (film.poster) {
      const img = document.createElement('img');
      img.className = 'fl-actor-card__img';
      img.src = film.poster;
      img.alt = '';
      img.loading = 'lazy';
      main.append(img);
    } else {
      main.append(el('span', 'fl-actor-card__img fl-actor-card__img--empty', film.title.slice(0, 1).toUpperCase()));
    }

    main.append(el('span', 'fl-actor-card__title', film.title));
    main.append(el('span', 'fl-actor-card__meta', film.year ? String(film.year) : ''));
    wrapper.append(main);

    const imdbUrl = FL.safeUrl(film.imdbUrl);
    if (imdbUrl) {
      const imdb = el('a', 'fl-actor-card__imdb', 'IMDb');
      imdb.href = imdbUrl;
      imdb.target = '_blank';
      imdb.rel = 'noopener noreferrer';
      imdb.title = t('actors.imdb');
      wrapper.append(imdb);
    }

    return wrapper;
  }

  /* ------------------------- sortare + filtrare ------------------------ */

  let currentFilms = [];
  let sortMode = 'popular';
  let filterText = '';

  function sortedFilms() {
    const list = currentFilms.slice();
    if (sortMode === 'newest') list.sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (sortMode === 'oldest') list.sort((a, b) => (a.year || 9999) - (b.year || 9999));
    else if (sortMode === 'title') list.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    const needle = filterText.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((film) => String(film.title || '').toLowerCase().indexOf(needle) !== -1);
  }

  function renderGrid() {
    if (!overlay) return;
    const grid = overlay.querySelector('[data-role="grid"]');
    if (!grid) return;
    const films = sortedFilms();
    grid.replaceChildren();
    if (!films.length) {
      grid.append(el('p', 'fl-actor-msg', t('actors.filtered')));
    } else {
      films.forEach((film) => grid.append(card(film)));
    }
    const count = overlay.querySelector('[data-role="count"]');
    if (count) count.textContent = films.length ? t('actors.films', { n: films.length }) : '';
  }

  function buildTools() {
    const tools = el('div', 'fl-actor-tools');

    const sortLabel = el('label', 'fl-actor-tools__sort');
    sortLabel.append(el('span', 'fl-actor-tools__label', t('actors.sort')));
    const select = document.createElement('select');
    [
      ['popular', t('actors.sortPopular')],
      ['newest', t('actors.sortNewest')],
      ['oldest', t('actors.sortOldest')],
      ['title', t('actors.sortTitle')],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
    select.value = sortMode;
    select.addEventListener('change', () => {
      sortMode = select.value;
      renderGrid();
    });
    sortLabel.append(select);
    tools.append(sortLabel);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'fl-actor-tools__filter';
    search.placeholder = t('actors.filter');
    search.value = filterText;
    search.addEventListener('input', () => {
      filterText = search.value;
      renderGrid();
    });
    tools.append(search);

    return tools;
  }

  async function openPanel(name) {
    if (!overlay) overlay = buildOverlay();
    overlay.hidden = false;
    overlay.querySelector('[data-role="title"]').textContent = t('actors.title', { name });
    setBody([el('p', 'fl-actor-msg', t('actors.loading'))]);
    currentFilms = [];

    const id = ++requestId;
    const response = await sendMessage({ type: 'actor:films', name });
    if (id !== requestId || !overlay || overlay.hidden) return;

    if (!response || !response.ok) {
      setBody([el('p', 'fl-actor-msg fl-actor-msg--error', t('actors.error'))]);
      return;
    }
    const films = response.films || [];
    if (!films.length) {
      setBody([el('p', 'fl-actor-msg', t('actors.empty'))]);
      return;
    }

    currentFilms = films;
    const grid = el('div', 'fl-actor-grid');
    grid.dataset.role = 'grid';
    const count = el('p', 'fl-actor-count', '');
    count.dataset.role = 'count';
    setBody([buildTools(), grid, count]);
    renderGrid();
  }

  /* ------------------------------ pornire ------------------------------ */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[FL.SETTINGS_KEY]) return;
      FL.getSettings().then((next) => {
        settings = next;
        attachMagnifiers();
      });
    });
  } catch (_) {
    /* ignorăm */
  }

  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'a') return;
    const first = castCells()[0];
    if (!first) return;
    event.preventDefault();
    openPanel(first.name);
  });

  const observer = new MutationObserver(() => {
    if (!settings || !settings.showActorFilms) return;
    try {
      attachMagnifiers();
    } catch (_) {
      /* pagina se poate descărca între timp */
    }
  });

  FL.getSettings().then((loaded) => {
    settings = loaded;
    if (!settings.showActorFilms) return;
    attachMagnifiers();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
