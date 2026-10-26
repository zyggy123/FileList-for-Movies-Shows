/**
 * Rândul de note (Letterboxd / IMDb / Rotten Tomatoes / Metacritic) pe paginile
 * de detalii FileList (filelist.io/details.php?id=...).
 * Nu folosește API-ul FileList: citește pagina și cere notele de la surse publice.
 */
(function () {
  'use strict';

  const FL = globalThis.FL;
  if (!FL || globalThis.__flDetailsCard) return;
  globalThis.__flDetailsCard = true;

  const DEBOUNCE_MS = 200;

  let root = null;
  let settings = null;
  let imdbId = '';
  let state = { loading: false, ratings: null, missing: {}, message: '' };
  let mountTimer = null;
  let mountedSig = '';
  let panelOpen = false;

  /* ----------------------------- utilitare ----------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'options:open' }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* ignorăm */
    }
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

  /* --------------------------- datele paginii -------------------------- */

  function findImdbId() {
    for (const anchor of document.querySelectorAll('a[href*="imdb.com/title/tt"]')) {
      const id = FL.normalizeImdbId(anchor.getAttribute('href'));
      if (id) return id;
    }
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const match = html.match(/imdb\.com\/title\/(tt\d{6,})/i) || html.match(/\b(tt\d{7,})\b/i);
    return match ? FL.normalizeImdbId(match[1]) : '';
  }

  function torrentName() {
    const selectors = ['.cblock-header h4', '#details h1', '.torrent_name', 'h1', '.header', 'title'];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = node && node.textContent ? node.textContent.trim() : '';
      if (text) return text.replace(/\s*(?:::|-)\s*FileList\s*$/i, '');
    }
    return document.title;
  }

  /** FileList: `.cblock-innercontent` e blocul cu dată / poster / badge-uri. */
  function findAnchor() {
    const inner = document.querySelector('.cblock-innercontent');
    if (inner) {
      // chiar sub linia cu „...torrent” (primul <hr>), deasupra posterului
      const separator = inner.querySelector('hr.separator');
      if (separator) return { node: separator, mode: 'after' };
      return { node: inner, mode: 'prepend' };
    }
    const link = document.querySelector('a[href*="imdb.com/title/tt"]');
    if (link) {
      const block = link.closest('tr, li, p, div, td');
      return { node: block && block !== document.body ? block : link, mode: 'after' };
    }
    const heading = document.querySelector('.cblock-header, h1, h4');
    if (heading) return { node: heading, mode: 'after' };
    return { node: document.querySelector('#maincolumn, main') || document.body, mode: 'prepend' };
  }

  /* ------------------------------- UI ---------------------------------- */

  /** Logo-urile reale, salvate local în icons/src-*.png (16px). */
  const SOURCE_ICON = {
    lb: 'icons/src-lb.png',
    imdb: 'icons/src-imdb.png',
    rt: 'icons/src-rt.png',
    'rt-aud': 'icons/src-rt.png',
    mc: 'icons/src-mc.png',
  };

  const SOURCE_LABEL = {
    lb: 'Letterboxd',
    imdb: 'IMDb',
    rt: 'Rotten Tomatoes',
    mc: 'Metacritic',
  };

  function iconFor(kind) {
    if (kind === 'rt-aud') return el('span', 'fl-rb__pop', '🍿'); // popcornmeter
    const img = document.createElement('img');
    img.className = 'fl-rb__img';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.src = chrome.runtime.getURL(SOURCE_ICON[kind] || SOURCE_ICON.imdb);
    return img;
  }

  function ratingBadge(kind, value, href, tooltip) {
    const node = el('a', 'fl-rb fl-rb--' + kind);
    const safe = FL.safeUrl(href);
    if (safe) {
      node.href = safe;
      if (!settings || settings.openInNewTab) {
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
      }
    }
    node.append(iconFor(kind));
    node.append(el('span', 'fl-rb__val', value));
    if (tooltip) node.title = tooltip;
    return node;
  }

  function percent(value, best) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !numeric) return null;
    return Math.round((numeric / (best || 5)) * 100);
  }

  function buildBadges(ratings) {
    const lang = settings.lang;
    const nodes = [];

    if (ratings.lb) {
      const value = percent(ratings.lb.value, ratings.lb.best || 5);
      if (value !== null) {
        nodes.push(
          ratingBadge(
            'lb',
            value + '%',
            ratings.lb.url,
            'Letterboxd ' + Number(ratings.lb.value).toFixed(2) + '/5' + votesText(ratings.lb.votes),
          ),
        );
      }
    }

    if (ratings.imdb) {
      nodes.push(
        ratingBadge(
          'imdb',
          Number(ratings.imdb.value).toFixed(1),
          ratings.imdb.url || 'https://www.imdb.com/title/' + imdbId + '/',
          'IMDb ' + ratings.imdb.value + '/10' + votesText(ratings.imdb.votes),
        ),
      );
    }

    if (ratings.rt) {
      if (Number.isFinite(ratings.rt.critics)) {
        nodes.push(
          ratingBadge('rt', ratings.rt.critics + '%', ratings.rt.url, 'Rotten Tomatoes – ' + FL.t(lang, 'ratings.critics')),
        );
      }
      if (Number.isFinite(ratings.rt.audience)) {
        nodes.push(
          ratingBadge('rt-aud', ratings.rt.audience + '%', ratings.rt.url, 'Rotten Tomatoes – ' + FL.t(lang, 'ratings.audience')),
        );
      }
    }

    if (ratings.mc) {
      nodes.push(ratingBadge('mc', String(ratings.mc.value), ratings.mc.url, 'Metacritic ' + ratings.mc.value + '/100'));
    }

    return nodes;
  }

  function votesText(count) {
    const formatted = FL.formatVotes(count);
    return formatted ? ' · ' + FL.t(settings.lang, 'ratings.votes', { n: formatted }) : '';
  }

  function buildPanel(ratings) {
    const lang = settings.lang;
    const panel = el('div', 'fl-ratings__panel');
    const rows = [
      ['Letterboxd', ratings.lb && Number(ratings.lb.value).toFixed(2) + '/5', ratings.lb, ratings.lb && ratings.lb.url],
      ['IMDb', ratings.imdb && ratings.imdb.value + '/10', ratings.imdb, ratings.imdb && (ratings.imdb.url || 'https://www.imdb.com/title/' + imdbId + '/')],
      [
        'Rotten Tomatoes',
        ratings.rt
          ? [Number.isFinite(ratings.rt.critics) ? ratings.rt.critics + '%' : '', Number.isFinite(ratings.rt.audience) ? '🍿 ' + ratings.rt.audience + '%' : '']
              .filter(Boolean)
              .join(' / ')
          : '',
        ratings.rt,
        ratings.rt && ratings.rt.url,
      ],
      ['Metacritic', ratings.mc && ratings.mc.value + '/100', ratings.mc, ratings.mc && ratings.mc.url],
    ];

    rows.forEach(([label, value, data, href]) => {
      if (!data || !value) return;
      const row = el('div', 'fl-ratings__row');
      row.append(el('span', 'fl-ratings__row-name', label));
      row.append(el('span', 'fl-ratings__row-value', value));
      const votes = FL.formatVotes(data.votes);
      if (votes) row.append(el('span', 'fl-ratings__row-sub', FL.t(lang, 'ratings.votes', { n: votes })));
      const safe = FL.safeUrl(href);
      if (safe) {
        const open = el('a', 'fl-ratings__row-link', '↗');
        open.href = safe;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        row.append(open);
      }
      panel.append(row);
    });

    const actions = el('div', 'fl-ratings__actions');
    const refresh = el('button', 'fl-ratings__action', '⟳ ' + FL.t(lang, 'ratings.refresh'));
    refresh.type = 'button';
    refresh.addEventListener('click', () => load({ force: true }));
    actions.append(refresh);

    const optionsButton = el('button', 'fl-ratings__action', '⚙ ' + FL.t(lang, 'card.settings'));
    optionsButton.type = 'button';
    optionsButton.addEventListener('click', openOptions);
    actions.append(optionsButton);

    if (imdbId) actions.append(el('span', 'fl-ratings__id', imdbId));
    panel.append(actions);
    return panel;
  }

  function buildRoot() {
    const fixed = FL.isFixedPosition(settings.position);
    const node = el('div', 'fl-ratings');
    node.dataset.position = settings.position;
    if (fixed) node.classList.add('fl-ratings--fixed', 'fl-ratings--' + settings.position);
    FL.applyCardTheme(node, settings.theme, document, 'fl-ratings');
    return node;
  }

  function render() {
    if (!root) return;
    const lang = settings.lang;
    root.replaceChildren();

    const bar = el('div', 'fl-ratings__bar');

    if (state.loading) {
      bar.append(el('span', 'fl-ratings__msg', FL.t(lang, 'ratings.loading')));
    } else if (state.message) {
      bar.append(el('span', 'fl-ratings__msg', state.message));
    } else {
      const badges = buildBadges(state.ratings || {});
      if (!badges.length) {
        bar.append(el('span', 'fl-ratings__msg', FL.t(lang, 'ratings.none')));
      } else {
        badges.forEach((badge) => bar.append(badge));
      }
    }

    if (!state.loading && !state.message && state.ratings) {
      const toggle = el('button', 'fl-ratings__more', '›');
      toggle.type = 'button';
      toggle.title = FL.t(lang, 'ratings.refresh');
      toggle.setAttribute('aria-label', FL.t(lang, 'ratings.refresh'));
      toggle.addEventListener('click', () => {
        panelOpen = !panelOpen;
        toggle.classList.toggle('fl-ratings__more--open', panelOpen);
        const existing = root.querySelector('.fl-ratings__panel');
        if (panelOpen) {
          if (!existing) root.append(buildPanel(state.ratings));
        } else if (existing) {
          existing.remove();
        }
      });
      if (panelOpen) toggle.classList.add('fl-ratings__more--open');
      bar.append(toggle);
    }

    root.append(bar);

    const missing = state.missing || {};
    const missingList = ['rt', 'imdb', 'mc', 'lb']
      .filter((key) => missing[key])
      .map((key) => SOURCE_LABEL[key] + ' (' + missing[key] + ')');
    if (missingList.length && !state.loading) {
      root.append(el('p', 'fl-ratings__missing', FL.t(lang, 'ratings.missing', { list: missingList.join(', ') })));
    }

    if (panelOpen && !state.loading && state.ratings) root.append(buildPanel(state.ratings));
  }

  /* ------------------------------ montare ------------------------------ */

  function removeCard() {
    if (root) root.remove();
    root = null;
    mountedSig = '';
  }

  function insertCard(node) {
    if (FL.isFixedPosition(settings.position)) {
      (document.body || document.documentElement).append(node);
      return true;
    }
    const anchor = findAnchor();
    if (!anchor || !anchor.node) return false;
    if (settings.position === 'before') anchor.node.insertAdjacentElement('beforebegin', node);
    else if (settings.position === 'below' || anchor.mode === 'after') anchor.node.insertAdjacentElement('afterend', node);
    else anchor.node.insertAdjacentElement('afterbegin', node);
    return true;
  }

  function ensure() {
    if (!settings || !settings.showRatings) {
      removeCard();
      return;
    }
    if (!FL.isCategoryAllowed(settings, FL.detectFilelistCategory(document))) {
      removeCard();
      return;
    }
    const sig = JSON.stringify([settings.lang, settings.theme, settings.position, imdbId]);
    if (root && root.isConnected && sig === mountedSig) {
      render();
      return;
    }
    removeCard();
    root = buildRoot();
    render();
    if (!insertCard(root)) {
      root.remove();
      root = null;
      return;
    }
    mountedSig = sig;
  }

  /* ------------------------------ datele ------------------------------- */

  async function resolveImdbId() {
    if (imdbId) return imdbId;
    const name = torrentName();
    if (!name) return '';
    const response = await sendMessage({ type: 'ratings:resolve', title: name });
    if (response && response.ok && response.imdbId) {
      imdbId = response.imdbId;
      return imdbId;
    }
    return '';
  }

  async function load(options) {
    if (!settings) return;
    state = { loading: true, ratings: null, missing: {}, message: '' };
    ensure();

    if (!imdbId) await resolveImdbId();
    if (!imdbId) {
      state = { loading: false, ratings: null, missing: {}, message: FL.t(settings.lang, 'ratings.noId') };
      ensure();
      return;
    }

    const response = await sendMessage({
      type: 'ratings:get',
      imdbId,
      title: torrentName(),
      force: Boolean(options && options.force),
    });

    if (response && response.ok) {
      state = { loading: false, ratings: response.ratings || {}, missing: response.missing || {}, message: '' };
    } else {
      state = { loading: false, ratings: null, missing: {}, message: FL.t(settings.lang, 'ratings.error') };
    }
    ensure();
  }

  function scheduleEnsure() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      if (root && !root.isConnected) {
        mountedSig = '';
        ensure();
      }
    }, DEBOUNCE_MS);
  }

  /* ------------------------------ pornire ------------------------------ */

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[FL.SETTINGS_KEY]) return;
      FL.getSettings().then((next) => {
        settings = next;
        mountedSig = '';
        ensure();
      });
    });
  } catch (_) {
    /* ignorăm */
  }

  new MutationObserver(scheduleEnsure).observe(document.documentElement, { childList: true, subtree: true });

  FL.getSettings().then((loaded) => {
    settings = loaded;
    if (!settings.showRatings) return;
    imdbId = findImdbId();
    load();
  });
})();
