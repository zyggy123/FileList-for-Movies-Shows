/**
 * Lupa de lângă „Subtitrare" din pagina FileList: caută release-ul exact
 * (ex. Spider-Man.2.2004.1080p.BluRay.DD+7.1.x264-playHD) pe mai multe site-uri.
 */
(function () {
  'use strict';

  const FL = globalThis.FL;
  if (!FL || globalThis.__flSubs) return;
  globalThis.__flSubs = true;

  const HEADER_RE = /subtitr|subtitle/i;

  let settings = null;
  let overlay = null;
  let copyTimer = null;

  /* ----------------------------- utilitare ----------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function t(key, vars) {
    return FL.t(settings ? settings.lang : 'ro', key, vars);
  }

  function magnifierIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '10');
    circle.setAttribute('cy', '10');
    circle.setAttribute('r', '6.5');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2.6');
    const handle = document.createElementNS(ns, 'line');
    handle.setAttribute('x1', '15');
    handle.setAttribute('y1', '15');
    handle.setAttribute('x2', '21');
    handle.setAttribute('y2', '21');
    handle.setAttribute('stroke', 'currentColor');
    handle.setAttribute('stroke-width', '2.8');
    handle.setAttribute('stroke-linecap', 'round');
    svg.append(circle, handle);
    return svg;
  }

  /** Numele exact al release-ului (cu puncte), din antetul torrentului. */
  function releaseName() {
    const selectors = ['.cblock-header h4', '.cblock-header', 'h1', 'title'];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = node && node.textContent ? node.textContent.trim() : '';
      if (text) return text.replace(/\s*(?:::|-)\s*FileList\s*$/i, '').trim();
    }
    return '';
  }

  /* ------------------------------ opțiunile ---------------------------- */

  function options(name) {
    const encoded = encodeURIComponent(name);
    return [
      {
        key: 'filelist',
        label: 'FileList',
        hint: t('subs.filelist'),
        url: 'https://filelist.io/browse.php?search=' + encoded,
      },
      {
        key: 'subdl',
        label: 'SubDL',
        hint: 'subdl.com',
        url: 'https://subdl.com/search/' + encoded,
      },
      {
        key: 'subtitlecat',
        label: 'SubtitleCat',
        hint: 'subtitlecat.com',
        url: 'https://www.subtitlecat.com/index.php?search=' + encoded,
      },
      {
        key: 'subf2m',
        label: 'Subf2m',
        hint: 'subf2m.co',
        url: 'https://subf2m.co/subtitles/searchbytitle?query=' + encoded,
      },
      {
        key: 'addic7ed',
        label: 'Addic7ed',
        hint: t('subs.addic7ed'),
        url: 'https://www.addic7ed.com/search.php?search=' + encoded + '&Submit=Search',
      },
      {
        key: 'duckduckgo',
        label: 'DuckDuckGo',
        hint: t('subs.webSearch'),
        url: 'https://duckduckgo.com/?q=' + encoded + '+subtitles',
      },
      {
        key: 'google',
        label: 'Google',
        hint: t('subs.webSearch'),
        url: 'https://www.google.com/search?q=' + encoded + '+subtitles',
      },
    ];
  }

  /* ------------------------------- panoul ------------------------------ */

  function buildOverlay() {
    const root = el('div', 'fl-actor-overlay');
    root.hidden = true;
    root.addEventListener('click', (event) => {
      if (event.target === root) closePanel();
    });

    const panel = el('div', 'fl-actor-panel fl-subs-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const head = el('div', 'fl-actor-head');
    const title = el('h3', 'fl-actor-title', t('subs.title'));
    head.append(title);
    const close = el('button', 'fl-actor-close', '✕');
    close.type = 'button';
    close.title = t('subs.close');
    close.setAttribute('aria-label', t('subs.close'));
    close.addEventListener('click', () => closePanel());
    head.append(close);
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

  function copyName(name, button) {
    const done = () => {
      if (copyTimer) clearTimeout(copyTimer);
      button.textContent = t('subs.copied');
      button.classList.add('fl-subs-copy--done');
      copyTimer = setTimeout(() => {
        button.textContent = t('subs.copy');
        button.classList.remove('fl-subs-copy--done');
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(name).then(done, done);
    } else {
      done();
    }
  }

  function render(name) {
    const body = overlay ? overlay.querySelector('[data-role="body"]') : null;
    if (!body) return;
    body.replaceChildren();

    const label = el('p', 'fl-subs-name', name);
    label.title = name;
    body.append(label);

    const list = el('div', 'fl-subs-list');
    for (const option of options(name)) {
      const link = el('a', 'fl-subs-item fl-subs-item--' + option.key);
      const safe = FL.safeUrl(option.url);
      if (safe) {
        link.href = safe;
        if (!settings || settings.openInNewTab) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
      }
      link.append(el('span', 'fl-subs-item__label', option.label));
      link.append(el('span', 'fl-subs-item__hint', option.hint));
      link.append(el('span', 'fl-subs-item__arrow', '↗'));
      list.append(link);
    }
    body.append(list);

    const copy = el('button', 'fl-subs-copy', t('subs.copy'));
    copy.type = 'button';
    copy.addEventListener('click', () => copyName(name, copy));
    body.append(copy);
  }

  function openPanel(name) {
    if (!name) return;
    if (!overlay) overlay = buildOverlay();
    overlay.hidden = false;
    const title = overlay.querySelector('.fl-actor-title');
    if (title) title.textContent = t('subs.title');
    render(name);
  }

  /* ------------------------------ montare ------------------------------ */

  function subtitleHeaders() {
    const found = [];
    for (const node of document.querySelectorAll('.colhead, th')) {
      const text = (node.textContent || '').trim();
      if (!text || text.length > 24 || !HEADER_RE.test(text)) continue;
      found.push(node);
    }
    return found;
  }

  function attachMagnifiers() {
    if (!settings || !settings.showSubSearch) return;
    if (!document.body) return;
    if (!FL.isCategoryAllowed(settings, FL.detectFilelistCategory(document))) return;
    const name = releaseName();
    if (!name) return;

    for (const header of subtitleHeaders()) {
      if (header.querySelector('.fl-subs-mag')) continue;
      const button = el('button', 'fl-subs-mag');
      button.type = 'button';
      button.title = t('subs.tooltip');
      button.setAttribute('aria-label', t('subs.tooltip'));
      button.append(magnifierIcon());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPanel(releaseName());
      });
      header.append(button);
    }
  }

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

  const observer = new MutationObserver(() => {
    if (!settings || !settings.showSubSearch) return;
    try {
      attachMagnifiers();
    } catch (_) {
      /* pagina se poate descărca între timp */
    }
  });

  FL.getSettings().then((loaded) => {
    settings = loaded;
    if (!settings.showSubSearch) return;
    attachMagnifiers();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
