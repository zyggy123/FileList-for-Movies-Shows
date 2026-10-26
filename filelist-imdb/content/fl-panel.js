/**
 * Card FileList injectat pe paginile de film/serial (IMDb, Rotten Tomatoes, Letterboxd, TMDB, ...).
 * Doar linkuri de căutare – fără API, fără cont, fără cereri.
 */
(function () {
  'use strict';

  const FL = globalThis.FL;
  if (!FL || globalThis.__flPanel) return;
  globalThis.__flPanel = true;

  const DEBOUNCE_MS = 250;

  let card = null;
  let settings = null;
  let mountedSig = '';
  let mountTimer = null;
  let copyTimer = null;
  let dismissed = false;

  let pageCache = null;
  let pageHref = '__none__';

  /* ----------------------------- utilitare ----------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function link(className, text, href) {
    const node = el('a', className, text);
    const safe = FL.safeUrl(href);
    if (!safe) return node;
    node.href = safe;
    if (!settings || settings.openInNewTab) {
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
    return node;
  }

  function getPage() {
    if (pageCache && pageHref === location.href && pageCache.query) return pageCache;
    const page = FL.detectPage(document, location.href);
    pageCache = page;
    pageHref = location.href;
    return page;
  }

  /**
   * Găsește elementul după care se inserează cardul.
   * Întâi containerul mare al site-ului (ex. `#hero-wrap` pe RT, `div.product-hero` pe Metacritic),
   * apoi titlul, apoi orice `<h1>`, apoi `<main>`.
   * Astfel cardul nu ajunge în interiorul unor layere cu overlay / re-randate de framework.
   */
  function findAnchor(site) {
    const containers = (site && site.containerSelectors) || [];
    for (const selector of containers) {
      for (const node of document.querySelectorAll(selector)) {
        if (!FL.isNoiseNode(node)) return node;
      }
    }
    const titles = (site && site.titleSelectors) || [];
    for (const selector of titles) {
      for (const node of document.querySelectorAll(selector)) {
        if (!FL.isNoiseNode(node)) return node;
      }
    }
    for (const node of document.querySelectorAll('h1')) {
      if (!FL.isNoiseNode(node)) return node;
    }
    return document.querySelector('main, [role="main"], #main, #content, article');
  }

  function blockOf(node) {
    const block = node.closest('section, article, header, [class*="hero"], [class*="Hero"], [class*="banner"]');
    return block && block !== document.body ? block : node;
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'options:open' }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* ignorăm */
    }
  }

  /* ------------------------------ copiere ------------------------------ */

  function legacyCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    } catch (_) {
      /* ignorăm */
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  function flashCopied(button, label) {
    if (copyTimer) clearTimeout(copyTimer);
    button.textContent = FL.t(settings.lang, 'card.copied');
    button.classList.add('fl-card__id--copied');
    copyTimer = setTimeout(() => {
      button.textContent = label;
      button.classList.remove('fl-card__id--copied');
    }, 1400);
  }

  /* -------------------------------- UI --------------------------------- */

  function applyTheme(node) {
    FL.applyCardTheme(node, settings ? settings.theme : 'auto', document);
  }

  function hintText(page, lang) {
    if (page.imdbId) return FL.t(lang, 'card.hintId');
    if (page.originalTitle) return FL.t(lang, 'card.hintOriginal');
    return FL.t(lang, 'card.hintTitle');
  }

  function buildCard(page) {
    const lang = settings.lang;
    const design = settings.design;
    const fixed = FL.FIXED_POSITIONS.includes(settings.position);
    const compact = design === 'compact' || design === 'minimal';

    const root = el('div', 'fl-card fl-card--' + design);
    root.dataset.site = page.site ? page.site.id : 'generic';
    root.dataset.design = design;
    root.dataset.imdbId = page.imdbId || '';
    if (fixed) root.classList.add('fl-card--fixed', 'fl-card--' + settings.position);

    /* header (nu există la designul „minimal”) */
    if (design !== 'minimal') {
      const head = el('div', 'fl-card__head');
      head.append(el('span', 'fl-card__logo', 'FL'));
      if (!compact) head.append(el('span', 'fl-card__brand', 'FileList'));

      if (page.imdbId) {
        const chip = el('button', 'fl-card__id', page.imdbId);
        chip.type = 'button';
        chip.dataset.action = 'copy';
        chip.title = FL.t(lang, 'card.copyId');
        head.append(chip);
      } else if (page.site) {
        head.append(el('span', 'fl-card__site', page.site.label));
      }

      if (fixed) head.append(closeButton(lang));
      root.append(head);
    }

    /* acțiuni */
    const actions = el('div', 'fl-card__actions');
    const primary = link('fl-card__btn fl-card__btn--primary', FL.t(lang, 'card.search'), FL.browseSearchUrl(page.query));
    primary.title = FL.t(lang, 'card.searchTip', { q: page.query });
    if (design === 'minimal') primary.prepend(el('span', 'fl-card__logo fl-card__logo--inline', 'FL'));
    actions.append(primary);

    if (settings.showNameSearch && page.title && page.query !== page.title) {
      const byName = link('fl-card__btn', FL.t(lang, 'card.byTitle'), FL.browseSearchUrl(page.title));
      byName.title = FL.t(lang, 'card.byTitleTip', { title: page.title });
      actions.append(byName);
    }

    const settingsButton = el('button', 'fl-card__btn fl-card__btn--ghost', design === 'minimal' ? '⚙' : FL.t(lang, 'card.settings'));
    settingsButton.type = 'button';
    settingsButton.dataset.action = 'settings';
    settingsButton.title = FL.t(lang, 'card.settings');
    actions.append(settingsButton);
    if (design === 'minimal' && fixed) actions.append(closeButton(lang));
    root.append(actions);

    if (!compact) root.append(el('p', 'fl-card__hint', hintText(page, lang)));

    root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'copy' && page.imdbId) {
        event.preventDefault();
        copyText(page.imdbId);
        flashCopied(target, page.imdbId);
      } else if (action === 'settings') {
        event.preventDefault();
        openOptions();
      } else if (action === 'close') {
        event.preventDefault();
        dismissed = true;
        removeCard();
      }
    });

    return root;
  }

  function closeButton(lang) {
    const close = el('button', 'fl-card__close', '✕');
    close.type = 'button';
    close.dataset.action = 'close';
    close.title = FL.t(lang, 'card.close');
    close.setAttribute('aria-label', FL.t(lang, 'card.close'));
    return close;
  }

  /* ------------------------------ montare ------------------------------ */

  function removeCard() {
    if (card) card.remove();
    card = null;
    mountedSig = '';
  }

  function insertCard(node, page) {
    if (FL.FIXED_POSITIONS.includes(settings.position)) {
      (document.body || document.documentElement).append(node);
      return true;
    }
    const anchor = findAnchor(page.site);
    if (!anchor) return false;
    const target = settings.position === 'below' ? blockOf(anchor) : anchor;
    if (settings.position === 'before') target.insertAdjacentElement('beforebegin', node);
    else target.insertAdjacentElement('afterend', node);
    return true;
  }

  function ensure() {
    if (!settings) return;
    if (!settings.showCard || dismissed) {
      removeCard();
      return;
    }

    const page = getPage();
    if (!page.query) {
      removeCard();
      return;
    }

    const sig = JSON.stringify([
      settings.lang,
      settings.theme,
      settings.design,
      settings.position,
      settings.openInNewTab,
      settings.showNameSearch,
      page.imdbId,
      page.title,
      page.originalTitle,
      page.site ? page.site.id : '',
    ]);

    if (card && card.isConnected && sig === mountedSig) {
      applyTheme(card);
      return;
    }

    removeCard();
    const node = buildCard(page);
    applyTheme(node);
    if (!insertCard(node, page)) return;
    card = node;
    mountedSig = sig;
  }

  function scheduleEnsure() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      ensure();
    }, DEBOUNCE_MS);
  }

  /* ------------------------------ pornire ------------------------------ */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[FL.SETTINGS_KEY]) return;
      FL.getSettings().then((next) => {
        settings = next;
        pageCache = null;
        removeCard();
        ensure();
      });
    });
  } catch (_) {
    /* fără storage rămân setările implicite */
  }

  new MutationObserver(scheduleEnsure).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'f') return;
    const page = getPage();
    if (!page.query) return;
    event.preventDefault();
    window.open(FL.browseSearchUrl(page.query), settings && settings.openInNewTab ? '_blank' : '_self', 'noopener');
  });

  window.addEventListener('popstate', scheduleEnsure);
  window.addEventListener('pageshow', scheduleEnsure);

  setInterval(() => {
    if (location.href !== pageHref) {
      pageCache = null;
      scheduleEnsure();
    } else if (card && !card.isConnected) {
      scheduleEnsure();
    }
  }, 1000);

  FL.getSettings().then((loaded) => {
    settings = loaded;
    ensure();
  });
})();
