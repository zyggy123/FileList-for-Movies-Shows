/**
 * Cod comun pentru service worker, paginile extensiei și content script.
 * Se încarcă clasic (importScripts / <script> / content_scripts), NU ca ES module.
 *
 * Extensia construiește linkuri de căutare și citește note publice (IMDb, RT, Metacritic, Letterboxd).
 */
(function (root) {
  'use strict';

  if (root.FL) return;

  const SITE_URL = 'https://filelist.io';
  const BROWSE_URL = 'https://filelist.io/browse.php';
  const SETTINGS_KEY = 'fl_settings';

  /** Categoriile FileList pentru care apar cardurile (implicit). */
  const FILELIST_CATEGORIES = [
    'Movies 3D',
    'Movies 4K',
    'Movies 4K Blu-Ray',
    'Movies Blu-Ray',
    'Movies DVD',
    'Movies DVD-RO',
    'Movies HD',
    'Movies HD-RO',
    'Movies SD',
    'Music',
    'RO Dubbed',
    'Sport',
    'TV-Series 4K',
    'TV-Series HD',
    'TV-Series SD',
  ];

  /** Valorile permise pentru cât timp se păstrează cache-ul (zile). */
  const CACHE_DAYS = [1, 2, 5, 7, 14, 24];

  const LANGS = ['ro', 'en'];
  const THEMES = ['auto', 'dark', 'light'];
  const DESIGNS = ['classic', 'compact', 'minimal', 'banner', 'glass', 'outline', 'flat'];
  const POSITIONS = [
    'after',          // sub titlu
    'before',         // deasupra titlului
    'below',          // după tot blocul titlului (hero)
    'top',            // bară fixă sus
    'bottom',         // bară fixă jos
    'floating-right', // plutitor dreapta jos
    'floating-left',  // plutitor stânga jos
  ];
  /** Pozițiile care ies din fluxul paginii (fixed). */
  const FIXED_POSITIONS = ['top', 'bottom', 'floating-right', 'floating-left'];

  const DEFAULT_SETTINGS = Object.freeze({
    showCard: true,        // afișează cardul
    showNameSearch: true,  // butonul „Caută după titlu”
    openInNewTab: true,    // linkurile se deschid în tab nou
    lang: 'ro',            // limba interfeței: ro | en
    theme: 'auto',         // culori: auto | dark | light
    design: 'classic',     // designul cardului: classic | compact | minimal | banner | glass | outline | flat
    position: 'after',     // unde apare: vezi POSITIONS
    showRatings: true,     // cardul cu note (IMDb/RT/Metacritic/Letterboxd) pe pagina FileList
    showActorFilms: true,  // lupa de lângă actori -> filmele actorului (postere catre FileList/IMDb)
    showSubSearch: true,   // lupa de lângă „Subtitrare” -> căutare release exact
    categoryMode: 'selected', // 'selected' = doar categoriile bifate, 'all' = toate categoriile
    cacheDays: 7,             // cât timp se păstrează notele/filmografiile în cache (zile)
    categories: FILELIST_CATEGORIES.slice(), // categoriile în care apar cardurile
  });

  /* ------------------------------------------------------------------ */
  /* Site-uri acceptate                                                  */
  /* ------------------------------------------------------------------ */

  const SITES = [
    {
      id: 'imdb',
      label: 'IMDb',
      host: 'imdb.com',
      path: /\/title\//i,
      idFromPath: /\/title\/(tt\d{6,})/i,
      titleSelectors: ['h1[data-testid="hero__pageTitle"]', 'h1[data-testid="hero-title-block__title"]', 'main h1', 'h1'],
      suffixes: [/ - IMDb$/i, / \| IMDb$/i],
    },
    {
      id: 'rottentomatoes',
      label: 'Rotten Tomatoes',
      host: 'rottentomatoes.com',
      path: /\/(m|tv)\//i,
      titleSelectors: ['h1#media-hero-label', 'h1[data-qa="score-panel-title"]', 'h1.unset', 'h1'],
      // h1-ul stă în .media-hero-wrap, peste care se suprapune hero-ul: inserăm după tot hero-ul
      containerSelectors: ['#hero-wrap', 'div.media-hero-wrap'],
      suffixes: [/ \| Rotten Tomatoes$/i, / - Rotten Tomatoes$/i, / - Movie Reviews$/i],
    },
    {
      id: 'letterboxd',
      label: 'Letterboxd',
      host: 'letterboxd.com',
      path: /\/film\//i,
      titleSelectors: ['h1.headline-1.primaryname', 'h1.headline-1', '.headline-1', 'h1'],
      suffixes: [/ \| Letterboxd$/i, / • Letterboxd$/i],
    },
    {
      id: 'tmdb',
      label: 'TMDB',
      host: 'themoviedb.org',
      path: /\/(movie|tv)\//i,
      titleSelectors: ['div.header h2 a', 'h2.title', 'div.header h2', 'h2', 'h1'],
      containerSelectors: ['div.header'],
      suffixes: [/ — The Movie Database \(TMDB\)$/i, / - The Movie Database/i],
    },
    {
      id: 'thetvdb',
      label: 'TheTVDB',
      host: 'thetvdb.com',
      path: /\/(series|movies)\//i,
      titleSelectors: ['h1', '.page-title'],
      suffixes: [/ - TheTVDB\.com$/i],
    },
    {
      id: 'trakt',
      label: 'Trakt',
      host: 'trakt.tv',
      path: /\/(movies|shows)\//i,
      titleSelectors: [
        '[data-testid="summary-title"]',
        'h1.movie-title',
        'h1.show-title',
        'h1',
      ],
      suffixes: [/ - Trakt$/i, / \| Trakt$/i],
    },
    {
      id: 'metacritic',
      label: 'Metacritic',
      host: 'metacritic.com',
      path: /\/(movie|tv)\//i,
      titleSelectors: ['[data-testid="hero-title"] h1', 'h1.c-productHero_title', 'h1[class*="title"]', 'h1'],
      // hero-ul e randat de Vue: inserăm în afara lui, ca să nu fie șters la re-render
      containerSelectors: ['div.product-hero', '[class*="product-hero"]'],
      suffixes: [/ Reviews? - Metacritic$/i, / - Metacritic$/i],
    },
    {
      id: 'allocine',
      label: 'AlloCiné',
      host: 'allocine.fr',
      path: /\/(film|series)\//i,
      // ATENȚIE: primul <h1> din pagină e breadcrumb-ul („Film » Titlu de Regizor”)
      titleSelectors: ['div.titlebar-title', '.titlebar-title-xl', 'h1.titlebar-page', 'h1'],
      containerSelectors: ['.titlebar.titlebar-page'],
      suffixes: [/ - AlloCiné$/i],
    },
    {
      id: 'filmaffinity',
      label: 'FilmAffinity',
      host: 'filmaffinity.com',
      path: /\/film\d+\.html/i,
      titleSelectors: ['h1#film-my-jack', 'h1[itemprop="name"]', 'h1'],
      suffixes: [/ - FilmAffinity$/i],
    },
  ];

  /* ------------------------------------------------------------------ */
  /* Setări                                                              */
  /* ------------------------------------------------------------------ */

  async function getSettings() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get(SETTINGS_KEY);
    } catch (_) {
      /* context fără storage – folosim valorile implicite */
    }
    const saved = (stored && stored[SETTINGS_KEY]) || {};
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (merged.position === 'floating') merged.position = 'floating-right'; // valoare veche
    return merged;
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch || {});
    next.showCard = Boolean(next.showCard);
    next.showNameSearch = Boolean(next.showNameSearch);
    next.openInNewTab = Boolean(next.openInNewTab);
    next.showRatings = Boolean(next.showRatings);
    next.showActorFilms = Boolean(next.showActorFilms);
    next.showSubSearch = Boolean(next.showSubSearch);
    next.categoryMode = next.categoryMode === 'all' ? 'all' : 'selected';
    next.cacheDays = CACHE_DAYS.includes(Number(next.cacheDays)) ? Number(next.cacheDays) : DEFAULT_SETTINGS.cacheDays;
    const allowed = Array.isArray(next.categories) ? next.categories : DEFAULT_SETTINGS.categories;
    next.categories = allowed.filter((name, index) => typeof name === 'string' && allowed.indexOf(name) === index);
    next.lang = LANGS.includes(next.lang) ? next.lang : DEFAULT_SETTINGS.lang;
    next.theme = THEMES.includes(next.theme) ? next.theme : DEFAULT_SETTINGS.theme;
    next.design = DESIGNS.includes(next.design) ? next.design : DEFAULT_SETTINGS.design;
    next.position = POSITIONS.includes(next.position) ? next.position : DEFAULT_SETTINGS.position;
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  /* ------------------------------------------------------------------ */
  /* Identificare pagină (IMDb ID + titlu)                               */
  /* ------------------------------------------------------------------ */

  /** Acceptă "tt27419420", "27419420", "https://www.imdb.com/title/tt27419420/". */
  function normalizeImdbId(input) {
    if (!input) return '';
    const value = String(input).trim();
    const match = value.match(/(tt\d{6,})/i) || value.match(/^(\d{6,})$/);
    if (!match) return '';
    const id = match[1].toLowerCase();
    return id.startsWith('tt') ? id : 'tt' + id;
  }

  function detectSite(href) {
    let host = '';
    let path = '';
    try {
      const url = new URL(String(href));
      host = url.hostname.toLowerCase().replace(/^www\./, '');
      path = url.pathname;
    } catch (_) {
      return null;
    }
    let best = null;
    for (const site of SITES) {
      if (host !== site.host && !host.endsWith('.' + site.host)) continue;
      if (site.path && !site.path.test(path)) continue;
      if (!best || site.host.length > best.host.length) best = site;
    }
    return best;
  }

  function cleanTitle(raw, site) {
    let title = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!title) return '';
    const suffixes = (site && site.suffixes) || [];
    for (const suffix of suffixes) title = title.replace(suffix, '').trim();
    // „Film (2024)” / „Film 2024” -> „Film” (dar nu stricăm titluri ca „1917”)
    const withoutYear = title.replace(/\s*[(\[]?\b(19|20)\d{2}\b[)\]]?\s*$/, '').trim();
    if (withoutYear && /[a-zăâîșț]/i.test(withoutYear) && withoutYear.length >= 2) title = withoutYear;
    return title;
  }

  /** Elemente de navigare care nu trebuie confundate cu titlul (ex. breadcrumb-ul AlloCiné). */
  const NOISE_SELECTOR =
    'nav, [role="navigation"], [class*="breadcrumb"], [class*="Breadcrumb"], [aria-label*="readcrumb"]';

  /** Titluri care nu sunt titluri de film (nume de site, shell-uri de aplicație). */
  const IGNORED_TITLES = [
    'traktweb',
    'trakt',
    'imdb',
    'rottentomatoes',
    'letterboxd',
    'metacritic',
    'tmdb',
    'themoviedatabase',
    'thetvdb',
    'allocine',
    'filmaffinity',
    'filelist',
    'justamoment',
    'loading',
    'filme',
    'seriale',
    'movies',
    'shows',
  ];

  function normalizeTitleKey(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function isUsableTitle(value) {
    const text = String(value || '').trim();
    if (text.length < 2) return false;
    const key = normalizeTitleKey(text);
    if (!key) return false;
    if (IGNORED_TITLES.indexOf(key) !== -1) return false;
    return true;
  }

  /** Titlu derivat din URL (ultimul segment de tip slug), pentru SPA-uri fără titlu în DOM. */
  function titleFromUrl(href) {
    let parts = [];
    try {
      parts = new URL(String(href)).pathname.split('/').filter(Boolean);
    } catch (_) {
      return '';
    }
    let slug = parts.length ? parts[parts.length - 1] : '';
    if (/^(movies?|shows?|film|films|series|tv|title|details\.php)$/i.test(slug)) {
      slug = parts.length > 1 ? parts[parts.length - 2] : '';
    }
    slug = slug.replace(/\.[a-z]{2,4}$/i, '').replace(/[?=].*$/, '');
    slug = slug.replace(/^\d+-/, ''); // TMDB: /movie/693134-dune-part-two
    if (!slug || /^tt\d+$/i.test(slug) || /^\d+$/.test(slug)) return '';
    const yearMatch = slug.match(/(?:^|[-_])((?:19|20)\d{2})$/);
    const year = yearMatch ? yearMatch[1] : '';
    if (year) slug = slug.slice(0, -year.length - 1);
    const text = slug.replace(/[-_+]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!text || text.length < 3) return '';
    return year ? text + ' ' + year : text;
  }

  function isNoiseNode(node) {
    return Boolean(node && node.closest && node.closest(NOISE_SELECTOR));
  }

  function extractTitle(doc, site) {
    const selectors = (site && site.titleSelectors) || [];
    for (const selector of selectors) {
      const nodes = doc.querySelectorAll(selector);
      for (const node of nodes) {
        if (isNoiseNode(node)) continue;
        const text = cleanTitle(node.textContent, site);
        if (isUsableTitle(text)) return text;
      }
    }
    const og = doc.querySelector('meta[property="og:title"], meta[name="og:title"], meta[name="twitter:title"]');
    const ogText = og ? cleanTitle(og.getAttribute('content'), site) : '';
    if (isUsableTitle(ogText)) return ogText;
    const docTitle = cleanTitle(doc.title, site);
    if (isUsableTitle(docTitle)) return docTitle;
    return '';
  }

  /** Etichete de titlu original în mai multe limbi (FilmAffinity, AlloCiné etc.). */
  const ORIGINAL_TITLE_LABEL =
    /^(?:t[ií]tulo\s+original|titre\s+original|original\s+title|originaltitel|titolo\s+originale|orig\.?\s*title|original\s+name|原名|оригинальное\s+название)\b/i;

  /**
   * Titlul original (englezesc/internațional) al filmului, dacă pagina îl afișează.
   * Pe site-uri ca FilmAffinity / AlloCiné titlul vizibil e tradus, iar FileList
   * are release-uri după numele original → căutarea după el dă rezultate.
   */
  function findOriginalTitle(doc) {
    if (!doc) return '';

    // <dt>Título original</dt><dd>Dune: Part Two</dd>
    for (const term of doc.querySelectorAll('dt')) {
      const text = (term.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 40 || !ORIGINAL_TITLE_LABEL.test(text)) continue;
      const value = term.nextElementSibling;
      if (value && /^DD$/i.test(value.tagName)) {
        const cleaned = cleanTitle(value.textContent, null);
        if (cleaned) return cleaned;
      }
    }

    // "Titre original : Dune: Part Two" într-un bloc de metadate
    const blocks = doc.querySelectorAll(
      'dl, .meta-body, [class*="meta-body"], [class*="movie-info"], [class*="film-info"], [class*="short-info"]',
    );
    for (const block of blocks) {
      const text = (block.textContent || '').replace(/\s+/g, ' ');
      const match = text.match(
        /(?:t[ií]tulo\s+original|titre\s+original|original\s+title|originaltitel|titolo\s+originale)\s*[:：]?\s*([^|•·\n]{2,90})/i,
      );
      if (!match) continue;
      const cleaned = cleanTitle(match[1], null);
      if (cleaned) return cleaned;
    }

    return '';
  }

  /** Caută un IMDb ID oriunde în pagină: linkuri, JSON-LD, meta, apoi <head>. */
  function findImdbId(doc) {
    if (!doc) return '';

    const anchors = doc.querySelectorAll('a[href*="imdb.com/title/tt"], a[href*="imdb.com/Title?tt"]');
    for (const anchor of anchors) {
      const id = normalizeImdbId(anchor.getAttribute('href'));
      if (id) return id;
    }

    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const id = searchJson(JSON.parse(script.textContent));
        if (id) return id;
      } catch (_) {
        const raw = normalizeImdbId(script.textContent);
        if (raw) return raw;
      }
    }

    const metas = doc.querySelectorAll('meta[content*="imdb.com/title/tt"], link[href*="imdb.com/title/tt"]');
    for (const node of metas) {
      const id = normalizeImdbId(node.getAttribute('content') || node.getAttribute('href'));
      if (id) return id;
    }

    const head = doc.head ? doc.head.innerHTML : '';
    const match = head.match(/imdb\.com\/title\/(tt\d{6,})/i) || head.match(/\btt\d{6,}\b/i);
    return match ? normalizeImdbId(match[1] || match[0]) : '';
  }

  function searchJson(value, depth) {
    const level = depth || 0;
    if (value === null || value === undefined || level > 6) return '';
    if (typeof value === 'string') return normalizeImdbId(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = searchJson(item, level + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const found = searchJson(value[key], level + 1);
        if (found) return found;
      }
    }
    return '';
  }

  /**
   * Analizează pagina curentă și întoarce tot ce trebuie ca să construim linkul.
   * @returns {{site: object|null, imdbId: string, title: string, query: string}}
   */
  function detectPage(doc, href) {
    const site = detectSite(href);
    let imdbId = '';
    if (site && site.idFromPath) {
      const match = String(href).match(site.idFromPath);
      if (match) imdbId = normalizeImdbId(match[1]);
    }
    if (!imdbId) imdbId = findImdbId(doc);
    const title = doc ? extractTitle(doc, site) : '';
    const originalTitle = imdbId ? '' : doc ? findOriginalTitle(doc) : '';
    const slugTitle = titleFromUrl(href);
    return { site, imdbId, title, originalTitle, slugTitle, query: imdbId || originalTitle || title || slugTitle };
  }

  /* ------------------------------------------------------------------ */
  /* Linkuri                                                             */
  /* ------------------------------------------------------------------ */

  /** Caută pe FileList după IMDb ID (sau, dacă nu există, după text). */
  function browseSearchUrl(query) {
    const imdbId = normalizeImdbId(query);
    const text = imdbId || String(query || '').trim();
    return BROWSE_URL + '?search=' + encodeURIComponent(text);
  }

  function safeUrl(url) {
    const value = String(url || '').trim();
    return /^https?:\/\//i.test(value) ? value : '';
  }

  /** Poziția curentă iese din fluxul paginii (position: fixed)? */
  function isFixedPosition(position) {
    return FIXED_POSITIONS.indexOf(position) !== -1;
  }

  /* ------------------------- categorii FileList ------------------------ */

  /** Potrivește textul categoriei cu una din lista cunoscută. */
  function matchFilelistCategory(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const sorted = FILELIST_CATEGORIES.slice().sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      if (text === name) return name;
      if (text.toLowerCase().indexOf(name.toLowerCase()) === 0) return name;
    }
    return text;
  }

  /** Categoria torrentului de pe pagina de detalii FileList (ex. „Movies HD-RO"). */
  function detectFilelistCategory(doc) {
    const scope = doc || (typeof document !== 'undefined' ? document : null);
    if (!scope) return '';

    // 1) pagina de detalii: <b>Category</b> ... <img src=".../folder.png"> Movies HD-RO
    const folder = scope.querySelector('img[src*="folder."]');
    if (folder) {
      let text = folder.nextSibling && folder.nextSibling.nodeValue ? folder.nextSibling.nodeValue : '';
      if (!text.replace(/[^A-Za-z0-9]/g, '') && folder.parentElement) {
        text = (folder.parentElement.textContent || '').replace(/category/i, ' ');
      }
      const found = matchFilelistCategory(text);
      if (found) return found;
    }

    // 2) eticheta „Category" -> restul textului din acelasi bloc
    for (const node of scope.querySelectorAll('b, td, th, div, span, strong')) {
      const label = (node.textContent || '').trim();
      if (!/^category\s*:?$/i.test(label)) continue;
      const block = node.parentElement;
      if (!block) continue;
      const text = (block.textContent || '').replace(/category/i, ' ').trim();
      const found = matchFilelistCategory(text);
      if (found) return found;
    }

    // 3) doar in blocul principal - NU in tabelele „Related Torrents" / „Recomandari"
    const main = scope.querySelector('#maincolumn .cblock-innercontent, #maincolumn');
    if (main) {
      const flat = (main.textContent || '').replace(/\s+/g, ' ');
      const sorted = FILELIST_CATEGORIES.slice().sort((a, b) => b.length - a.length);
      for (const name of sorted) {
        if (flat.indexOf(name) !== -1) return name;
      }
    }
    return '';
  }

  /** Cardurile apar in categoria curenta? Categoria necunoscuta inseamna „nu". */
  function isCategoryAllowed(settings, category) {
    if (!settings) return true;
    if (settings.categoryMode === 'all') return true;
    const list = Array.isArray(settings.categories) ? settings.categories : DEFAULT_SETTINGS.categories;
    if (!category) return false;
    return list.indexOf(category) !== -1;
  }

  /** Pagina e pe temă deschisă? (folosit pentru stilul „automat”). */
  function pageIsLight(doc) {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    if (!target || !target.body) return false;
    try {
      const view = target.defaultView || globalThis;
      const bg = view.getComputedStyle(target.body).backgroundColor || '';
      const parts = bg.match(/[\d.]+/g);
      if (!parts || parts.length < 3) return false;
      const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
      const luminance = (0.299 * Number(parts[0]) + 0.587 * Number(parts[1]) + 0.114 * Number(parts[2])) / 255;
      return alpha > 0.5 && luminance > 0.55;
    } catch (_) {
      return false;
    }
  }

  /** Aplică stilul ales pe card: „--light”, „--dark” (solid) sau automat (translucid). */
  function applyCardTheme(node, theme, doc, prefix) {
    const base = prefix || 'fl-card';
    const mode = theme || 'auto';
    const light = mode === 'light' || (mode === 'auto' && pageIsLight(doc));
    node.classList.toggle(base + '--light', light);
    node.classList.toggle(base + '--dark', mode === 'dark');
  }

  /* ------------------------------------------------------------------ */
  /* Note (IMDb / Rotten Tomatoes / Metacritic / Letterboxd)             */
  /* ------------------------------------------------------------------ */

  const RATINGS_CACHE_KEY = 'fl_ratings_cache_v4';
  const RATINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // o săptămână
  const RATINGS_MAX_ENTRIES = 300;

  const RATING_SOURCES = [
    { id: 'imdb', label: 'IMDb', best: 10, url: (id) => 'https://www.imdb.com/title/' + id + '/' },
    { id: 'rt', label: 'RT', best: 100, url: () => 'https://www.rottentomatoes.com/' },
    { id: 'mc', label: 'MC', best: 100, url: () => 'https://www.metacritic.com/' },
    { id: 'lb', label: 'LB', best: 5, url: () => 'https://letterboxd.com/' },
  ];

  /** "Dune: Part Two" -> "dune_part_two" (formatul de slug folosit de RT). */
  function slugify(title, separator) {
    const sep = separator || '_';
    return String(title || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, sep)
      .replace(new RegExp('\\' + sep + '+', 'g'), sep)
      .replace(new RegExp('^\\' + sep + '|\\' + sep + '$', 'g'), '');
  }

  /** Etichete de release după care numele filmului nu mai continuă. */
  const RELEASE_TAG_RE =
    /(?:^|[.\s_-])(?:480p|576p|720p|1080p|2160p|4k|uhd|hdr10?|dv|dolby|vision|remux|blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|hdcam|x264|x265|h264|h265|hevc|avc|10bit|aac|ac3|eac3|dts|truehd|atmos|ddp?5[.\s]?1|dd\+?7[.\s]?1|proper|repack|internal|extended|unrated|multi|ro|sub|subbed|dubbed|nf|amzn|dsnp|hmax|atvp)\b/i;

  /** „Beetlejuice.Beetlejuice.2024.1080p.BluRay.x264” -> { title: „Beetlejuice Beetlejuice”, year: 2024 } */
  function parseReleaseName(name) {
    const raw = String(name || '')
      .replace(/\.(?:torrent|mkv|mp4|avi)$/i, '')
      .trim();
    if (!raw) return { title: '', year: null };

    const tagIndex = raw.search(RELEASE_TAG_RE);
    let head = tagIndex > 0 ? raw.slice(0, tagIndex) : raw;
    head = head.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    let year = null;
    const trailing = head.match(/\s[(\[]?((?:19|20)\d{2})[)\]]?\s*$/);
    if (trailing) {
      year = Number(trailing[1]);
      head = head.slice(0, trailing.index).trim();
    }
    if (!year) {
      const anyYear = raw.match(/\b((?:19|20)\d{2})\b/);
      if (anyYear) year = Number(anyYear[1]);
    }
    head = head.replace(/[-–—\s]+$/, '').trim();
    return { title: head, year };
  }

  /** Scoate anul de la finalul unui titlu: „The Batman 2022” -> „The Batman”. */
  function stripYear(value) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    const stripped = text.replace(/\s*[(\[]?\b(?:19|20)\d{2}\b[)\]]?\s*$/, '').trim();
    return stripped || text;
  }

  /** "K-Pop.Demon.Hunters.2025.1080p.BluRay.x264" -> "K-Pop Demon Hunters 2025" */
  function cleanReleaseName(name) {
    const parsed = parseReleaseName(name);
    if (!parsed.title) return '';
    return parsed.year ? parsed.title + ' ' + parsed.year : parsed.title;
  }

  function findAggregateRating(value, depth) {
    const level = depth || 0;
    if (!value || level > 6) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findAggregateRating(item, level + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;

    const rating = value.aggregateRating;
    if (rating && typeof rating === 'object') {
      const numeric = Number(rating.ratingValue);
      if (Number.isFinite(numeric) && numeric > 0) {
        return {
          value: numeric,
          best: Number(rating.bestRating) || null,
          votes: Number(rating.ratingCount || rating.reviewCount) || null,
          name: rating.name || '',
        };
      }
    }
    for (const key of Object.keys(value)) {
      const found = findAggregateRating(value[key], level + 1);
      if (found) return found;
    }
    return null;
  }

  /** Citește aggregateRating din blocurile JSON-LD (IMDb, Letterboxd, Metacritic). */
  function parseJsonLdRating(html) {
    const source = String(html || '');
    const blocks = source.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const block of blocks) {
      const text = block[1]
        .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\/\s*/i, '')
        .replace(/\/\*\s*\]\]>\s*\*\/\s*$/i, '')
        .trim();
      if (!text || text[0] !== '{') continue;
      try {
        const found = findAggregateRating(JSON.parse(text));
        if (found) return found;
      } catch (_) {
        /* încercăm regex-ul de mai jos */
      }
    }
    const fallback = source.match(/"aggregateRating"\s*:\s*\{[^{}]*?"ratingValue"\s*:\s*"?([\d.]+)"?/i);
    if (fallback) {
      const numeric = Number(fallback[1]);
      if (Number.isFinite(numeric)) return { value: numeric, best: null, votes: null, name: '' };
    }
    return null;
  }

  /** Blocurile JSON din pagină (ld+json sau application/json). */
  function jsonBlocks(html) {
    const blocks = [];
    const re = /<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match = re.exec(String(html || ''));
    while (match) {
      blocks.push(match[1]);
      match = re.exec(String(html || ''));
    }
    return blocks;
  }

  /** Numele operei (Movie / TVSeries …) dintr-un obiect JSON — nu numele actorilor. */
  function findWorkName(value, depth) {
    const level = depth || 0;
    if (!value || level > 6) return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findWorkName(item, level + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    const type = value['@type'];
    const isWork =
      typeof type === 'string' &&
      /^(Movie|TVSeries|TVSeason|TVEpisode|TVShow|Series|CreativeWork|VideoObject)$/i.test(type);
    if (isWork && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
    for (const key of Object.keys(value)) {
      const found = findWorkName(value[key], level + 1);
      if (found) return found;
    }
    return '';
  }

  /** Scoate sufixul de site dintr-un titlu: „X | Rotten Tomatoes” -> „X”. */
  function stripWorkSuffix(text) {
    return String(text || '')
      .replace(
        /\s*[|•·]\s*(?:Rotten Tomatoes|Letterboxd|IMDb|Metacritic|Trakt|TMDB|The Movie Database.*|AlloCiné|FilmAffinity|TheTVDB)\s*$/i,
        '',
      )
      .replace(
        /\s+[-–—]\s*(?:Rotten Tomatoes|Letterboxd|IMDb|Metacritic|Trakt|TMDB|The Movie Database.*|AlloCiné|FilmAffinity|TheTVDB)\s*$/i,
        '',
      )
      .trim();
  }

  /** Decodează entitățile HTML uzuale. */
  function htmlDecode(text) {
    return String(text || '')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function parseAttributes(source) {
    const text = String(source || '');
    const attrs = {};
    const re = /([a-z0-9:_-]+)\s*=\s*"([^"]*)"/gi;
    let match = re.exec(text);
    while (match) {
      attrs[match[1].toLowerCase()] = match[2];
      match = re.exec(text);
    }
    return attrs;
  }

  function numberOrNull(value) {
    const numeric = Number(String(value === undefined || value === null ? '' : value).trim());
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  /**
   * Pagina de căutare RT e randată pe server și are scorurile în atribute:
   * <search-page-media-row release-year="2024" tomatometer-score="76">.
   */
  function parseRtSearch(html) {
    const source = String(html || '');
    const rows = [];
    const re = /<search-page-media-row\b([^>]*)>/gi;
    let match = re.exec(source);
    while (match) {
      const attrs = parseAttributes(match[1]);
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 1600);
      const hrefMatch = after.match(/href="(https:\/\/www\.rottentomatoes\.com\/[^"]+)"/i);
      const titleMatch = after.match(/slot="title"[^>]*>([\s\S]{0,160}?)</i);
      const title = cleanTitle(htmlDecode(titleMatch ? titleMatch[1] : ''), null);
      const critics = numberOrNull(attrs['tomatometer-score'] || attrs['tomatometerscore']);
      const year = numberOrNull(
        attrs['release-year'] || attrs['releaseyear'] || attrs['start-year'] || attrs['startyear'],
      );
      if (title) {
        rows.push({
          title,
          year,
          critics,
          url: hrefMatch ? hrefMatch[1] : '',
          certified: String(attrs['tomatometer-is-certified'] || attrs['tomatometeriscertified'] || '') === 'true',
        });
      }
      match = re.exec(source);
    }
    return rows;
  }

  /** Alege rândul cel mai potrivit (titlu + an), ca să nu luăm scorul altui film. */
  function pickRtRow(rows, title, year) {
    const list = Array.isArray(rows) ? rows : [];
    const wanted = normalizeTitleKey(title);
    if (!wanted) return null;
    const candidates = [];
    for (const row of list) {
      const key = normalizeTitleKey(row.title);
      if (!key) continue;
      const exact = key === wanted;
      const partial = key.indexOf(wanted) === 0 || wanted.indexOf(key) === 0;
      if (!exact && !partial) continue;
      let score = exact ? 4 : 2;
      if (year && row.year) score += Number(row.year) === Number(year) ? 3 : -2;
      if (row.critics) score += 1;
      candidates.push({ row, score });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].row;
  }

  /**
   * Titlul operei din pagină. Întâi `og:title` (stabil, are mereu titlul filmului),
   * apoi JSON-LD (doar `name` din obiectul Movie/TVSeries, nu din distribuție).
   */
  function parseWorkTitle(html) {
    const source = String(html || '');
    const og =
      source.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']{1,180})["']/i) ||
      source.match(/<meta[^>]+content=["']([^"']{1,180})["'][^>]+(?:property|name)=["']og:title["']/i);
    if (og) {
      const cleaned = cleanTitle(stripWorkSuffix(og[1]), null);
      if (cleaned) return cleaned;
    }
    for (const block of jsonBlocks(source)) {
      const text = block.trim();
      if (!text || text[0] !== '{') continue;
      try {
        const name = findWorkName(JSON.parse(text));
        if (name) {
          const cleaned = cleanTitle(name, null);
          if (cleaned) return cleaned;
        }
      } catch (_) {
        /* ignorăm blocurile invalide */
      }
    }
    const twitter =
      source.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']{1,180})["']/i) ||
      source.match(/<meta[^>]+content=["']([^"']{1,180})["'][^>]+name=["']twitter:title["']/i);
    if (twitter) return cleanTitle(stripWorkSuffix(twitter[1]), null);
    return '';
  }

  /** Scorurile RT din <script id="media-scorecard-json">. */
  function parseRtScores(html) {
    const match = String(html || '').match(
      /<script[^>]*id=["']media-scorecard-json["'][^>]*>([\s\S]*?)<\/script>/i,
    );
    if (!match) return null;
    try {
      const data = JSON.parse(match[1].trim());
      const critics = Number(data && data.criticsScore && data.criticsScore.score);
      const audience = Number(data && data.audienceScore && data.audienceScore.score);
      if (!Number.isFinite(critics) && !Number.isFinite(audience)) return null;
      return {
        critics: Number.isFinite(critics) ? critics : null,
        audience: Number.isFinite(audience) ? audience : null,
      };
    } catch (_) {
      return null;
    }
  }

  /** Potrivirea din răspunsul backend.metacritic.com: IMDb ID când există, altfel titlu + an. */
  function parseMetacriticSearch(json, imdbId, title, year) {
    const items = json && json.data && Array.isArray(json.data.items) ? json.data.items : [];
    const wantedId = normalizeImdbId(imdbId);
    const wantedTitle = normalizeTitleKey(stripYear(title));
    let best = null;

    for (const item of items) {
      if (!item) continue;
      const score = item.criticScoreSummary ? Number(item.criticScoreSummary.score) : NaN;
      if (!Number.isFinite(score)) continue;

      const images = Array.isArray(item.images) ? item.images : [];
      const ids = images.map((img) => String((img && img.id) || ''));
      const hasId = Boolean(wantedId) && ids.some((id) => id.toLowerCase().indexOf(wantedId) !== -1);
      const otherIds = ids
        .map((id) => (id.match(/tt\d{6,}/i) || [''])[0].toLowerCase())
        .filter((id) => id && id !== wantedId);
      // dacă itemul are alt IMDb ID, e alt film – nu-l acceptăm
      if (wantedId && otherIds.length && !hasId) continue;

      const itemTitle = normalizeTitleKey(item.title);
      const titleOk =
        Boolean(wantedTitle) &&
        Boolean(itemTitle) &&
        (itemTitle === wantedTitle || itemTitle.indexOf(wantedTitle) === 0 || wantedTitle.indexOf(itemTitle) === 0);

      const itemYear = Number(item.premiereYear) || Number(String(item.releaseDate || '').slice(0, 4)) || null;
      const yearOk = year && itemYear ? Number(itemYear) === Number(year) : null;

      if (!hasId && !titleOk) continue;

      let points = 0;
      if (hasId) points += 10;
      if (titleOk) points += 4;
      if (yearOk === true) points += 3;
      if (yearOk === false) points -= 3;

      if (!best || points > best.points) {
        best = {
          points,
          record: {
            value: score,
            slug: item.slug || '',
            title: item.title || '',
            year: itemYear,
            type: item.type || 'movie',
            matchedById: hasId,
          },
        };
      }
    }

    return best ? best.record : null;
  }

  function formatVotes(count) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1000000) return Math.round(value / 100000) / 10 + 'M';
    if (value >= 1000) return Math.round(value / 100) / 10 + 'k';
    return String(value);
  }

  /** Verdictul culorii pentru un scor (0-100). */
  function ratingTone(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return 'neutral';
    if (value >= 75) return 'good';
    if (value >= 50) return 'mid';
    return 'bad';
  }

  /** Compară două titluri tolerant (diacritice, punctuație, „&”). */
  function titlesMatch(a, b) {
    const norm = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
    const left = norm(a);
    const right = norm(b);
    if (!left || !right) return false;
    return left === right || left.startsWith(right) || right.startsWith(left);
  }

  /* ------------------------------------------------------------------ */
  /* Traduceri                                                           */
  /* ------------------------------------------------------------------ */

  const MESSAGES = {
    ro: {
      'card.search': 'Caută pe FileList',
      'card.searchTip': 'Deschide căutarea FileList pentru {q}',
      'card.byTitle': 'Caută după titlu',
      'card.byTitleTip': 'Caută pe FileList după numele filmului/serialului: {title}',
      'card.settings': 'Setări',
      'card.close': 'Închide',
      'card.copyId': 'Copiază IMDb ID',
      'card.copied': 'Copiat!',
      'card.hintId': 'Se deschide căutarea FileList după IMDb ID · fără cont',
      'card.hintOriginal': 'Se deschide căutarea FileList după titlul original · fără cont',
      'card.hintTitle': 'Se deschide căutarea FileList după titlu · fără cont',

      'ratings.title': 'Note',
      'ratings.loading': 'Se încarcă notele…',
      'ratings.none': 'Nicio notă găsită pentru acest titlu.',
      'ratings.error': 'Nu am putut lua notele acum.',
      'ratings.noId': 'Nu am găsit un IMDb ID pentru acest torent.',
      'ratings.refresh': 'Reîmprospătează',
      'ratings.votes': '{n} voturi',
      'ratings.open': 'Deschide {source}',
      'ratings.critics': 'critici',
      'ratings.audience': 'public',
      'ratings.missing': 'Fără notă: {list}',

      'actors.openActor': 'Vezi filmele cu {name}',
      'actors.title': 'Filme cu {name}',
      'actors.loading': 'Se caută filmele…',
      'actors.error': 'Nu am putut lua filmografia acum.',
      'actors.empty': 'Nicio filmografie găsită pentru acest nume.',
      'actors.search': 'Caută pe FileList',
      'actors.imdb': 'Deschide pe IMDb',
      'actors.close': 'Închide',
      'actors.films': '{n} filme',
      'options.showActorFilms': 'Arată lupa de lângă actori',
      'options.showActorFilmsHint': 'Un buton pe fiecare poză de actor, care deschide filmele lui cu postere — click pe poster duce pe FileList, pe sigla IMDb duce pe IMDb.',
      'options.showSubSearch': 'Arată lupa de lângă „Subtitrare”',
      'options.showSubSearchHint': 'Caută numele exact al release-ului pe site-uri de subtitrări (SubDL, SubtitleCat, Subf2m, Addic7ed) și pe Google / DuckDuckGo.',

      'subs.title': 'Caută subtitrări pentru acest release',
      'subs.tooltip': 'Caută subtitrări pentru release-ul exact',
      'subs.filelist': 'numele exact al release-ului',
      'subs.addic7ed': 'doar seriale (TV)',
      'subs.webSearch': 'căutare web',
      'subs.copy': 'Copiază numele release-ului',
      'subs.copied': 'Copiat!',
      'subs.close': 'Închide',

      'options.sectionSources': 'Test surse',
      'options.sourcesHint': 'O cerere de probă pe fiecare sursă: verde = răspunde, roșu = blocată (cu codul HTTP).',
      'options.testAll': 'Testează toate',
      'options.testOne': 'Testează',
      'options.testing': 'Se testează…',
      'options.sourceOk': 'OK',
      'options.sourceFail': 'Eșec',
      'options.sectionCache': 'Cache',
      'options.cacheDays': 'Cât timp să păstreze datele (zile)',
      'options.cacheDaysHint': 'Notele și filmografiile se țin în cache ca să nu fie cerute din nou la fiecare pagină.',
      'options.cacheClear': 'Golește cache-ul',
      'options.cacheCleared': 'Cache golit ({n} intrări).',
      'options.cacheEmpty': 'Cache-ul era deja gol.',
      'options.shortcutsHint': 'Scurtături: Alt+F = caută pagina curentă pe FileList · Alt+A = filmele actorului (pagina FileList).',

      'actors.sort': 'Sortează',
      'actors.sortPopular': 'Popularitate',
      'actors.sortNewest': 'An: nou → vechi',
      'actors.sortOldest': 'An: vechi → nou',
      'actors.sortTitle': 'Titlu A → Z',
      'actors.filter': 'Filtrează…',
      'actors.filtered': 'Niciun film pentru filtrul curent.',

      'options.title': 'FileList pentru filme și seriale',
      'options.subtitle': 'Buton de căutare pe FileList direct din pagina filmului, plus notele de pe IMDb, Rotten Tomatoes, Metacritic și Letterboxd pe pagina de detalii FileList.',
      'options.saved': 'Salvat.',
      'options.sectionDisplay': 'Afișare',
      'options.showCard': 'Afișează cardul',
      'options.showCardHint': 'Apare pe paginile de titlu de pe site-urile acceptate.',
      'options.showNameSearch': 'Afișează și butonul de căutare după titlu',
      'options.showNameSearchHint': 'A doua căutare, după numele filmului – utilă când IMDb ID-ul lipsește sau nu se potrivește.',
      'options.openInNewTab': 'Deschide linkurile într-un tab nou',
      'options.openInNewTabHint': 'Dacă e debifat, FileList se deschide în tabul curent (pierzi pagina filmului).',
      'options.sectionCategories': 'Categorii FileList',
      'options.categoriesHint': 'Cardurile (note, actori, subtitrări) apar doar pe torrentele din categoriile bifate.',
      'options.categoriesAll': 'Arată pe toate categoriile',
      'options.categoriesAllHint': 'Ignoră lista de mai jos.',
      'options.sectionLook': 'Aspect și limbă',
      'options.lang': 'Limbă',
      'options.langHint': 'Limba textele din card, setări și fereastra extensiei.',
      'options.theme': 'Stil',
      'options.themeAuto': 'Automat (după pagină)',
      'options.themeDark': 'Întunecat',
      'options.themeLight': 'Luminos',
      'options.themeHint': 'Culorile cardului. „Automat” detectează tema site-ului.',
      'options.design': 'Design',
      'options.designClassic': 'Card complet',
      'options.designCompact': 'Compact',
      'options.designMinimal': 'Doar buton',
      'options.designBanner': 'Bară colorată',
      'options.designGlass': 'Sticlă (glass)',
      'options.designOutline': 'Doar contur',
      'options.designFlat': 'Flat',
      'options.designHint': 'Cum arată cardul: de la cardul complet până la un singur buton discret.',
      'options.showRatings': 'Arată notele pe pagina FileList',
      'options.showRatingsHint': 'Card cu note IMDb / Rotten Tomatoes / Metacritic / Letterboxd pe fiecare pagină de detalii FileList.',
      'options.position': 'Unde să apară',
      'options.positionAfter': 'Sub titlu (recomandat)',
      'options.positionBefore': 'Deasupra titlului',
      'options.positionBelow': 'După tot blocul titlului',
      'options.positionTop': 'Bară fixă sus',
      'options.positionBottom': 'Bară fixă jos',
      'options.positionFloatingRight': 'Plutitor, dreapta jos',
      'options.positionFloatingLeft': 'Plutitor, stânga jos',
      'options.positionHint': 'Poziția cardului în pagină. Pozițiile fixe rămân vizibile la scroll.',
      'options.sectionHow': 'Cum funcționează',
      'options.howP1': 'Pe IMDb, Rotten Tomatoes, Letterboxd, TMDB, Trakt, Metacritic, AlloCiné și FilmAffinity citește pagina, scoate IMDb ID-ul (din link sau din datele paginii) și îți arată un buton care deschide căutarea FileList. Dacă nu găsește ID-ul, caută după titlul original, apoi după titlul afișat.',
      'options.howP2': 'Pe pagina de detalii FileList ia IMDb ID-ul din linkul IMDb (sau îl deduce din numele torrentului, până la an) și adună notele de pe IMDb, Rotten Tomatoes, Metacritic și Letterboxd. Notele se păstrează 7 zile, iar butonul de reîmprospătare le recalculează.',
      'options.howP3': 'Nu ai nevoie de cont sau passkey: linkurile se deschid în browserul tău, unde ești deja logat pe FileList, iar tot ce face extensia se întâmplă local, în Chrome.',
      'options.sectionSites': 'Site-uri acceptate',
      'options.sitesHint': 'Pe toate acestea cardul găsește IMDb ID-ul automat; dacă nu îl găsește, caută după titlu.',
      'options.sectionProbe': 'Verifică un IMDb ID',
      'options.probeHint': 'Lipește un link IMDb sau un ID (ex. tt27419420 sau 27419420).',
      'options.probeLabel': 'IMDb ID / link',
      'options.probeOpen': 'Deschide căutarea',
      'options.probeOk': 'IMDb ID: {id}',
      'options.probeGeneric': 'Nu arată a IMDb ID – se caută textul introdus.',
      'options.footer': 'fără cont · fără passkey · totul local, în Chrome',

      'popup.subtitle': 'căutare directă pe FileList',
      'popup.placeholder': 'IMDb ID, link sau titlu…',
      'popup.search': 'Caută',
      'popup.site': 'FileList',
      'popup.settings': 'Setări',
      'popup.hintEmpty': 'Ex: tt27419420, 27419420 sau un link imdb.com/title/tt…',
      'popup.hintId': 'Se caută după IMDb ID: {id}',
      'popup.hintText': 'Se caută textul: „{q}”',
    },
    en: {
      'card.search': 'Search on FileList',
      'card.searchTip': 'Open the FileList search for {q}',
      'card.byTitle': 'Search by title',
      'card.byTitleTip': 'Search FileList by movie/show name: {title}',
      'card.settings': 'Settings',
      'card.close': 'Close',
      'card.copyId': 'Copy IMDb ID',
      'card.copied': 'Copied!',
      'card.hintId': 'Opens the FileList search for the IMDb ID · no account needed',
      'card.hintOriginal': 'Opens the FileList search by the original title · no account needed',
      'card.hintTitle': 'Opens the FileList search by title · no account needed',

      'ratings.title': 'Ratings',
      'ratings.loading': 'Loading ratings…',
      'ratings.none': 'No ratings found for this title.',
      'ratings.error': 'Could not load the ratings right now.',
      'ratings.noId': 'No IMDb ID found for this torrent.',
      'ratings.refresh': 'Refresh',
      'ratings.votes': '{n} votes',
      'ratings.open': 'Open {source}',
      'ratings.critics': 'critics',
      'ratings.audience': 'audience',
      'ratings.missing': 'No score: {list}',

      'actors.openActor': 'See films with {name}',
      'actors.title': 'Films with {name}',
      'actors.loading': 'Loading films…',
      'actors.error': 'Could not load the filmography right now.',
      'actors.empty': 'No filmography found for this name.',
      'actors.search': 'Search on FileList',
      'actors.imdb': 'Open on IMDb',
      'actors.close': 'Close',
      'actors.films': '{n} films',
      'options.showActorFilms': 'Show the magnifier next to actors',
      'options.showActorFilmsHint': 'A button on every actor photo that opens their films with posters — click a poster for FileList, click the IMDb badge for IMDb.',
      'options.showSubSearch': 'Show the magnifier next to “Subtitles”',
      'options.showSubSearchHint': 'Searches the exact release name on subtitle sites (SubDL, SubtitleCat, Subf2m, Addic7ed) and on Google / DuckDuckGo.',

      'subs.title': 'Search subtitles for this release',
      'subs.tooltip': 'Search subtitles for the exact release',
      'subs.filelist': 'exact release name',
      'subs.addic7ed': 'TV shows only',
      'subs.webSearch': 'web search',
      'subs.copy': 'Copy the release name',
      'subs.copied': 'Copied!',
      'subs.close': 'Close',

      'options.sectionSources': 'Source test',
      'options.sourcesHint': 'One probe request per source: green = responding, red = blocked (with the HTTP code).',
      'options.testAll': 'Test all',
      'options.testOne': 'Test',
      'options.testing': 'Testing…',
      'options.sourceOk': 'OK',
      'options.sourceFail': 'Failed',
      'options.sectionCache': 'Cache',
      'options.cacheDays': 'How long to keep the data (days)',
      'options.cacheDaysHint': 'Ratings and filmographies are cached so they are not fetched again on every page.',
      'options.cacheClear': 'Clear the cache',
      'options.cacheCleared': 'Cache cleared ({n} entries).',
      'options.cacheEmpty': 'The cache was already empty.',
      'options.shortcutsHint': 'Shortcuts: Alt+F = search this page on FileList · Alt+A = the actor films (on a FileList page).',

      'actors.sort': 'Sort',
      'actors.sortPopular': 'Popularity',
      'actors.sortNewest': 'Year: new → old',
      'actors.sortOldest': 'Year: old → new',
      'actors.sortTitle': 'Title A → Z',
      'actors.filter': 'Filter…',
      'actors.filtered': 'No films match the current filter.',

      'options.title': 'FileList for movies & shows',
      'options.subtitle': 'A FileList search button right on the movie page, plus IMDb, Rotten Tomatoes, Metacritic and Letterboxd scores on the FileList details page.',
      'options.saved': 'Saved.',
      'options.sectionDisplay': 'Display',
      'options.showCard': 'Show the card',
      'options.showCardHint': 'Appears on title pages of the supported sites.',
      'options.showNameSearch': 'Also show the search-by-title button',
      'options.showNameSearchHint': 'The second search, by movie name – useful when the IMDb ID is missing or does not match.',
      'options.openInNewTab': 'Open links in a new tab',
      'options.openInNewTabHint': 'If unchecked, FileList opens in the current tab (you lose the movie page).',
      'options.sectionCategories': 'FileList categories',
      'options.categoriesHint': 'The cards (ratings, actors, subtitles) only appear on torrents from the checked categories.',
      'options.categoriesAll': 'Show on all categories',
      'options.categoriesAllHint': 'Ignores the list below.',
      'options.sectionLook': 'Look & language',
      'options.lang': 'Language',
      'options.langHint': 'Language of the texts in the card, settings and popup.',
      'options.theme': 'Style',
      'options.themeAuto': 'Automatic (match page)',
      'options.themeDark': 'Dark',
      'options.themeLight': 'Light',
      'options.themeHint': 'Card colors. “Automatic” follows the site theme.',
      'options.design': 'Design',
      'options.designClassic': 'Full card',
      'options.designCompact': 'Compact',
      'options.designMinimal': 'Button only',
      'options.designBanner': 'Colored bar',
      'options.designGlass': 'Glass',
      'options.designOutline': 'Outline only',
      'options.designFlat': 'Flat',
      'options.designHint': 'How the card looks: from the full card down to a single discreet button.',
      'options.showRatings': 'Show ratings on the FileList page',
      'options.showRatingsHint': 'A card with IMDb / Rotten Tomatoes / Metacritic / Letterboxd scores on every FileList details page.',
      'options.position': 'Where to show it',
      'options.positionAfter': 'Below the title (recommended)',
      'options.positionBefore': 'Above the title',
      'options.positionBelow': 'After the whole title block',
      'options.positionTop': 'Fixed bar at the top',
      'options.positionBottom': 'Fixed bar at the bottom',
      'options.positionFloatingRight': 'Floating, bottom right',
      'options.positionFloatingLeft': 'Floating, bottom left',
      'options.positionHint': 'Where the card sits. Fixed positions stay visible while scrolling.',
      'options.sectionHow': 'How it works',
      'options.howP1': 'On IMDb, Rotten Tomatoes, Letterboxd, TMDB, Trakt, Metacritic, AlloCiné and FilmAffinity it reads the page, extracts the IMDb ID (from the link or the page data) and shows a button that opens the FileList search. If it cannot find the ID, it searches by the original title, then by the displayed title.',
      'options.howP2': 'On the FileList details page it takes the IMDb ID from the IMDb link (or works it out from the torrent name, up to the year) and collects the scores from IMDb, Rotten Tomatoes, Metacritic and Letterboxd. Scores are kept for 7 days, and the refresh button fetches them again.',
      'options.howP3': 'No account or passkey needed: links open in your browser, where you are already logged in to FileList, and everything the extension does happens locally, in Chrome.',
      'options.sectionSites': 'Supported sites',
      'options.sitesHint': 'On all of these the card finds the IMDb ID automatically; if it cannot, it searches by title.',
      'options.sectionProbe': 'Check an IMDb ID',
      'options.probeHint': 'Paste an IMDb link or ID (e.g. tt27419420 or 27419420).',
      'options.probeLabel': 'IMDb ID / link',
      'options.probeOpen': 'Open the search',
      'options.probeOk': 'IMDb ID: {id}',
      'options.probeGeneric': 'Does not look like an IMDb ID – searching the text as typed.',
      'options.footer': 'no account · no passkey · all local, in Chrome',

      'popup.subtitle': 'direct search on FileList',
      'popup.placeholder': 'IMDb ID, link or title…',
      'popup.search': 'Search',
      'popup.site': 'FileList',
      'popup.settings': 'Settings',
      'popup.hintEmpty': 'E.g. tt27419420, 27419420 or an imdb.com/title/tt… link',
      'popup.hintId': 'Searching by IMDb ID: {id}',
      'popup.hintText': 'Searching for: “{q}”',
    },
  };

  function t(lang, key, vars) {
    const dict = MESSAGES[lang] || MESSAGES.ro;
    let text = dict[key];
    if (text === undefined) text = MESSAGES.ro[key];
    if (text === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach((name) => {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  /** Traduce în pagină toate nodurile marcate cu data-i18n*. */
  function applyI18n(doc, lang) {
    const dictionary = MESSAGES[lang] ? lang : 'ro';
    if (doc && doc.documentElement) doc.documentElement.lang = dictionary;
    doc.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(dictionary, node.dataset.i18n);
    });
    doc.querySelectorAll('[data-i18n-ph]').forEach((node) => {
      node.setAttribute('placeholder', t(dictionary, node.dataset.i18nPh));
    });
    doc.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.setAttribute('title', t(dictionary, node.dataset.i18nTitle));
    });
  }

  root.FL = {
    SITE_URL,
    BROWSE_URL,
    SETTINGS_KEY,
    LANGS,
    THEMES,
    DESIGNS,
    POSITIONS,
    FIXED_POSITIONS,
    DEFAULT_SETTINGS,
    SITES,
    MESSAGES,
    NOISE_SELECTOR,
    RATINGS_CACHE_KEY,
    RATINGS_TTL_MS,
    RATINGS_MAX_ENTRIES,
    RATING_SOURCES,
    getSettings,
    saveSettings,
    normalizeImdbId,
    detectSite,
    detectPage,
    findImdbId,
    extractTitle,
    findOriginalTitle,
    isNoiseNode,
    cleanTitle,
    isUsableTitle,
    titleFromUrl,
    browseSearchUrl,
    safeUrl,
    slugify,
    cleanReleaseName,
    parseReleaseName,
    stripYear,
    parseJsonLdRating,
    parseWorkTitle,
    jsonBlocks,
    findWorkName,
    stripWorkSuffix,
    parseRtScores,
    parseRtSearch,
    pickRtRow,
    htmlDecode,
    parseMetacriticSearch,
    formatVotes,
    ratingTone,
    titlesMatch,
    isFixedPosition,
    FILELIST_CATEGORIES,
    matchFilelistCategory,
    detectFilelistCategory,
    isCategoryAllowed,
    pageIsLight,
    applyCardTheme,
    t,
    applyI18n,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
