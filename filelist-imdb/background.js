/**
 * Service worker.
 * - deschide pagina de setări pentru cardul injectat în site-uri;
 * - aduce notele (IMDb / Rotten Tomatoes / Metacritic / Letterboxd) pentru pagina
 *   de detalii FileList. NU folosește API-ul FileList și nu cere nicio cheie.
 */
importScripts('lib/shared.js');

const FL = globalThis.FL;
const FETCH_TIMEOUT_MS = 12000;

/* ------------------------------------------------------------------ */
/* Fetch + cache                                                       */
/* ------------------------------------------------------------------ */

async function fetchText(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      url,
      Object.assign(
        {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        },
        options || {},
      ),
    );
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, url: response.url || url };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return { ok: false, status: 0, body: '', url, error: aborted ? 'timeout' : String(error && error.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function readCache() {
  try {
    const stored = await chrome.storage.local.get(FL.RATINGS_CACHE_KEY);
    return (stored && stored[FL.RATINGS_CACHE_KEY]) || {};
  } catch (_) {
    return {};
  }
}

async function writeCache(entry) {
  const map = await readCache();
  map[entry.imdbId] = {
    at: Date.now(),
    title: entry.title,
    ratings: entry.ratings,
    missing: entry.missing || {},
  };
  const keys = Object.keys(map)
    .sort((a, b) => (map[b].at || 0) - (map[a].at || 0))
    .slice(0, FL.RATINGS_MAX_ENTRIES);
  const trimmed = {};
  keys.forEach((key) => {
    trimmed[key] = map[key];
  });
  try {
    await chrome.storage.local.set({ [FL.RATINGS_CACHE_KEY]: trimmed });
  } catch (_) {
    /* cache-ul e opțional */
  }
}

function failureReason(res) {
  if (!res) return 'error';
  if (res.error) return res.error === 'timeout' ? 'timeout' : 'network';
  if (!res.ok) return 'http-' + res.status;
  return 'no-data';
}

/* ------------------------------------------------------------------ */
/* Surse de note (fiecare întoarce { rating, title, reason })           */
/* ------------------------------------------------------------------ */

async function fetchImdb(imdbId) {
  const res = await fetchText('https://www.imdb.com/title/' + imdbId + '/');
  if (!res.ok) return { reason: failureReason(res) };
  const rating = FL.parseJsonLdRating(res.body);
  if (!rating) return { reason: 'no-rating' };
  return {
    rating: { value: rating.value, best: rating.best || 10, votes: rating.votes, url: res.url },
    title: FL.parseWorkTitle(res.body),
  };
}

async function fetchLetterboxd(imdbId) {
  const res = await fetchText('https://letterboxd.com/imdb/' + imdbId + '/');
  if (!res.ok) return { reason: failureReason(res) };
  const rating = FL.parseJsonLdRating(res.body);
  if (!rating) return { reason: 'no-rating' };
  return {
    rating: { value: rating.value, best: rating.best || 5, votes: rating.votes, url: res.url },
    title: FL.parseWorkTitle(res.body),
  };
}

async function fetchMetacritic(queries, imdbId, year) {
  let reason = 'no-match';
  for (const query of queries) {
    const res = await fetchText(
      'https://backend.metacritic.com/finder/metacritic/search/' + encodeURIComponent(query) + '/web?offset=0&limit=10',
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) {
      reason = failureReason(res);
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch (_) {
      reason = 'bad-json';
      continue;
    }
    const record = FL.parseMetacriticSearch(json, imdbId, query, year);
    if (!record) {
      reason = 'no-match';
      continue;
    }
    return {
      rating: {
        value: record.value,
        best: 100,
        type: record.type,
        url: 'https://www.metacritic.com/' + record.type + '/' + record.slug + '/',
      },
    };
  }
  return { reason };
}

/** Slug-uri posibile pentru RT („The Batman” -> the_batman, batman, …). */
function slugVariants(title) {
  const list = [];
  const push = (value) => {
    const slug = FL.slugify(value, '_');
    if (slug && list.indexOf(slug) === -1) list.push(slug);
  };
  push(title);
  const undashed = FL.slugify(title, '-');
  if (undashed && list.indexOf(undashed) === -1) list.push(undashed);
  const withoutThe = String(title || '').replace(/^(the|a|an)\s+/i, '');
  if (withoutThe && withoutThe !== title) push(withoutThe);
  return list;
}

/** Completează scorul publicului din pagina filmului (opțional). */
async function rtWithAudience(row) {
  let critics = Number.isFinite(row.critics) ? row.critics : null;
  let audience = null;
  let url = row.url || '';
  if (row.url) {
    const detail = await fetchText(row.url);
    if (detail.ok) {
      const scores = FL.parseRtScores(detail.body);
      if (scores) {
        if (Number.isFinite(scores.critics) && scores.critics) critics = scores.critics;
        if (Number.isFinite(scores.audience)) audience = scores.audience;
      }
      url = detail.url || url;
    }
  }
  if (critics === null && audience === null) return { reason: 'no-score' };
  return { rating: { critics, audience, best: 100, url } };
}

/**
 * Rotten Tomatoes:
 * 1. pagina de căutare — e randată pe server și are scorurile în atribute
 *    (`<search-page-media-row tomatometer-score="76">`), deci nu depinde de ghicirea slug-ului;
 * 2. fallback: slug direct (`/m/<titlu_cu_underscore>`) + verificarea titlului.
 */
async function fetchRottenTomatoes(queries, year) {
  let reason = 'no-title';
  for (const query of queries) {
    const search = await fetchText('https://www.rottentomatoes.com/search?search=' + encodeURIComponent(query), {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!search.ok) {
      reason = failureReason(search);
      continue;
    }
    const rows = FL.parseRtSearch(search.body);
    const best = FL.pickRtRow(rows, query, year);
    if (best) return rtWithAudience(best);
    reason = rows.length ? 'no-match' : 'no-rows';
  }

  // fallback: slug direct, pentru cazurile în care căutarea nu întoarce rânduri utile
  for (const kind of ['m', 'tv']) {
    for (const query of queries) {
      for (const slug of slugVariants(query)) {
        const res = await fetchText('https://www.rottentomatoes.com/' + kind + '/' + slug);
        if (!res.ok) {
          reason = failureReason(res);
          continue;
        }
        const pageTitle = FL.parseWorkTitle(res.body);
        if (!FL.titlesMatch(pageTitle, query)) {
          reason = 'title-mismatch';
          continue;
        }
        const scores = FL.parseRtScores(res.body);
        if (!scores) {
          reason = 'no-score';
          continue;
        }
        return { rating: { critics: scores.critics, audience: scores.audience, best: 100, url: res.url } };
      }
    }
  }
  return { reason };
}

async function collectRatings(imdbId, fallbackTitle) {
  const ratings = {};
  const missing = {};

  const [imdb, letterboxd] = await Promise.all([fetchImdb(imdbId), fetchLetterboxd(imdbId)]);
  if (imdb.rating) ratings.imdb = imdb.rating;
  else missing.imdb = imdb.reason || 'error';
  if (letterboxd.rating) ratings.lb = letterboxd.rating;
  else missing.lb = letterboxd.reason || 'error';

  // numele torrentului: „Beetlejuice.Beetlejuice.2024.1080p.BluRay…” -> titlu + an
  const release = FL.parseReleaseName(fallbackTitle);
  const year = release.year || null;

  const queries = [];
  const addQuery = (value) => {
    const clean = FL.stripYear(value || '');
    if (!clean || clean.length < 2) return;
    const key = clean.toLowerCase();
    if (queries.some((item) => item.toLowerCase() === key)) return;
    queries.push(clean);
  };
  addQuery(imdb.title);
  addQuery(letterboxd.title);
  addQuery(release.title);

  const title = queries[0] || '';
  if (queries.length) {
    const searchQueries = queries.slice(0, 2);
    const [metacritic, rt] = await Promise.all([
      fetchMetacritic(searchQueries, imdbId, year),
      fetchRottenTomatoes(searchQueries, year),
    ]);
    if (metacritic.rating) ratings.mc = metacritic.rating;
    else missing.mc = metacritic.reason || 'error';
    if (rt.rating) ratings.rt = rt.rating;
    else missing.rt = rt.reason || 'error';
  } else {
    missing.mc = 'no-title';
    missing.rt = 'no-title';
  }

  return { imdbId, title, ratings, missing };
}

async function resolveImdbId(rawTitle) {
  const query = FL.cleanReleaseName(rawTitle);
  if (!query) return null;
  const res = await fetchText('https://v3.sg.media-imdb.com/suggestion/x/' + encodeURIComponent(query) + '.json', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    return null;
  }
  const items = (json && Array.isArray(json.d) ? json.d : []).filter((item) => item && /^tt\d+/.test(item.id || ''));
  if (!items.length) return null;
  const yearMatch = String(rawTitle).match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : null;
  const pick = (year && items.find((item) => Number(item.y) === year)) || items[0];
  return { imdbId: pick.id, title: pick.l || query, year: pick.y || null };
}

/* ------------------------------------------------------------------ */
/* Filmografia actorilor (Wikidata + postere de pe Wikipedia)          */
/* ------------------------------------------------------------------ */

const ACTOR_CACHE_KEY = 'fl_actor_cache';
const ACTOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTOR_MAX_ENTRIES = 200;
const ACTOR_MAX_FILMS = 24;

/** Cât timp se păstrează cache-ul, din setări (zile). */
async function cacheTtlMs() {
  const settings = await FL.getSettings();
  const days = Number(settings.cacheDays);
  return (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 60 * 60 * 1000;
}

function keyOf(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readJsonCache(key) {
  try {
    const stored = await chrome.storage.local.get(key);
    return (stored && stored[key]) || {};
  } catch (_) {
    return {};
  }
}

async function writeJsonCache(key, map, max) {
  const keys = Object.keys(map)
    .sort((a, b) => (map[b].at || 0) - (map[a].at || 0))
    .slice(0, max);
  const trimmed = {};
  keys.forEach((item) => {
    trimmed[item] = map[item];
  });
  try {
    await chrome.storage.local.set({ [key]: trimmed });
  } catch (_) {
    /* cache opțional */
  }
}

/** Posterele filmelor, în batch-uri, din Wikipedia (fără chei). */
async function fetchPosters(queries) {
  const posters = {};
  const list = queries.filter(Boolean);
  for (let index = 0; index < list.length; index += 40) {
    const chunk = list.slice(index, index + 40);
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1' +
      '&prop=pageimages&piprop=thumbnail&pithumbsize=240&pilimit=max&pilicense=any&titles=' +
      encodeURIComponent(chunk.join('|'));
    const res = await fetchText(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) continue;
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch (_) {
      continue;
    }
    const pages = json.query && json.query.pages ? json.query.pages : {};
    for (const page of Object.values(pages)) {
      if (page && page.thumbnail && page.thumbnail.source) {
        posters[keyOf(page.title)] = page.thumbnail.source;
      }
    }
    const redirects = json.query && Array.isArray(json.query.redirects) ? json.query.redirects : [];
    for (const redirect of redirects) {
      const target = posters[keyOf(redirect.to)];
      if (target) posters[keyOf(redirect.from)] = target;
    }
  }
  return posters;
}

/** „Michael Keaton” -> „michael-keaton” (formatul de slug de pe Letterboxd). */
function actorSlug(name) {
  return FL.slugify(name, '-');
}

/** „Batman (1989)” -> { title: „Batman”, year: 1989 } */
function splitNameAndYear(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (match) return { title: match[1].trim(), year: Number(match[2]) };
  return { title: text, year: null };
}

/**
 * Filmele unui actor: lista vine de pe Letterboxd (pagina de actor),
 * posterele din Wikipedia. Fără chei, fără cont.
 */
async function fetchActorFilms(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return { reason: 'no-name' };

  const slug = actorSlug(name);
  if (!slug) return { reason: 'no-name' };

  const page = await fetchText('https://letterboxd.com/actor/' + slug + '/');
  if (!page.ok) return { reason: failureReason(page) };

  const rows = [];
  const seen = new Set();
  const re = /data-item-name="([^"]+)"[^>]*data-item-slug="([^"]+)"/g;
  let match = re.exec(page.body);
  while (match) {
    const parsed = splitNameAndYear(FL.htmlDecode(match[1]));
    const itemSlug = match[2];
    if (parsed.title && !seen.has(itemSlug)) {
      seen.add(itemSlug);
      rows.push({ title: parsed.title, year: parsed.year, slug: itemSlug });
    }
    match = re.exec(page.body);
  }

  if (!rows.length) return { reason: 'no-films' };

  const films = rows.slice(0, ACTOR_MAX_FILMS);

  // posterele: mai multe variante de titlu, într-un singur batch
  const queries = [];
  const lookup = new Map();
  for (const film of films) {
    const variants = [];
    if (film.year) variants.push(film.title + ' (' + film.year + ' film)');
    variants.push(film.title + ' (film)');
    variants.push(film.title);
    if (film.year) variants.push(film.title + ' (' + film.year + ')');
    const unique = variants.filter((value, index) => variants.indexOf(value) === index);
    lookup.set(film.slug, unique);
    unique.forEach((value) => queries.push(value));
  }
  const posters = await fetchPosters(queries);

  return {
    name,
    source: 'letterboxd',
    films: films.map((film) => {
      const query = film.year ? film.title + ' ' + film.year : film.title;
      const variants = lookup.get(film.slug) || [];
      let poster = '';
      for (const variant of variants) {
        const found = posters[keyOf(variant)];
        if (found) {
          poster = found;
          break;
        }
      }
      return {
        title: film.title,
        year: film.year,
        slug: film.slug,
        poster,
        filelistUrl: 'https://filelist.io/browse.php?search=' + encodeURIComponent(query),
        imdbUrl: 'https://www.imdb.com/find/?q=' + encodeURIComponent(query),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Test surse + cache global + meniu contextual                        */
/* ------------------------------------------------------------------ */

const CACHE_KEYS = [
  FL.RATINGS_CACHE_KEY,
  'fl_ratings_cache_v3',
  'fl_ratings_cache_v2',
  'fl_ratings_cache',
  'fl_actor_cache',
];

async function clearCaches() {
  let removed = 0;
  for (const key of CACHE_KEYS) {
    try {
      const stored = await chrome.storage.local.get(key);
      const value = stored ? stored[key] : null;
      if (value && typeof value === 'object') removed += Object.keys(value).length;
      if (value) await chrome.storage.local.remove(key);
    } catch (_) {
      /* ignoram */
    }
  }
  return removed;
}

/** Cereri de proba, cate una per sursa. */
async function testSource(id) {
  const started = Date.now();
  const done = (ok, code, detail) => ({ ok: ok, code: code, ms: Date.now() - started, detail: detail || '' });

  if (id === 'imdb') {
    const res = await fetchText('https://www.imdb.com/title/tt0133093/');
    if (!res.ok) return done(false, res.status || 0);
    const rating = FL.parseJsonLdRating(res.body);
    return rating ? done(true, res.status, rating.value + '/10') : done(false, res.status, 'fara aggregateRating');
  }

  if (id === 'rt') {
    const search = await fetchText('https://www.rottentomatoes.com/search?search=' + encodeURIComponent('The Matrix'));
    if (!search.ok) return done(false, search.status || 0);
    const rows = FL.parseRtSearch(search.body);
    if (!rows.length) return done(false, search.status, 'fara randuri');
    const best = FL.pickRtRow(rows, 'The Matrix', 1999);
    if (!best) return done(false, search.status, 'randuri, dar fara potrivire');
    const detail = await fetchText(best.url);
    if (!detail.ok) return done(true, search.status, 'critici ' + (best.critics || '?') + '% (pagina filmului HTTP ' + (detail.status || 0) + ')');
    const scores = FL.parseRtScores(detail.body);
    return scores ? done(true, search.status, 'critici ' + scores.critics + '% / public ' + scores.audience + '%') : done(false, search.status, 'fara scorecard');
  }

  if (id === 'mc') {
    const res = await fetchText(
      'https://backend.metacritic.com/finder/metacritic/search/the%20matrix/web?offset=0&limit=10',
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return done(false, res.status || 0);
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch (_) {
      return done(false, res.status, 'JSON invalid');
    }
    const record = FL.parseMetacriticSearch(json, 'tt0133093', 'The Matrix', 1999);
    return record ? done(true, res.status, record.value + '/100') : done(false, res.status, 'fara potrivire');
  }

  if (id === 'lb') {
    const res = await fetchText('https://letterboxd.com/imdb/tt0133093/');
    if (!res.ok) return done(false, res.status || 0);
    const rating = FL.parseJsonLdRating(res.body);
    return rating ? done(true, res.status, rating.value + '/5') : done(false, res.status, 'fara rating');
  }

  if (id === 'actors') {
    const res = await fetchText('https://letterboxd.com/actor/keanu-reeves/');
    if (!res.ok) return done(false, res.status || 0);
    const count = (res.body.match(/data-item-name="/g) || []).length;
    return count ? done(true, res.status, count + ' filme') : done(false, res.status, 'fara filmografie');
  }

  if (id === 'wiki') {
    const res = await fetchText(
      'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1' +
        '&prop=pageimages&piprop=thumbnail&pithumbsize=200&pilimit=max&pilicense=any&titles=' +
        encodeURIComponent('The Matrix'),
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return done(false, res.status || 0);
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch (_) {
      return done(false, res.status, 'JSON invalid');
    }
    const pages = json.query && json.query.pages ? Object.values(json.query.pages) : [];
    const withImage = pages.filter((page) => page && page.thumbnail).length;
    return withImage ? done(true, res.status, withImage + ' poster') : done(false, res.status, 'fara poster');
  }

  return done(false, 0, 'sursa necunoscuta');
}

async function testAllSources() {
  const ids = ['imdb', 'rt', 'mc', 'lb', 'actors', 'wiki'];
  const results = {};
  for (const id of ids) {
    try {
      results[id] = await testSource(id);
    } catch (error) {
      results[id] = { ok: false, code: 0, ms: 0, detail: String(error && error.message) };
    }
  }
  return results;
}

/** Meniu contextual: cauta selectia pe FileList. */
async function ensureContextMenu() {
  if (!chrome.contextMenus) return;
  const settings = await FL.getSettings();
  const title = settings.lang === 'en' ? 'Search "%s" on FileList' : 'Cauta "%s" pe FileList';
  try {
    await chrome.contextMenus.removeAll();
  } catch (_) {
    /* nimic de sters */
  }
  chrome.contextMenus.create({ id: 'fl-search-selection', title: title, contexts: ['selection'] }, () => {
    void chrome.runtime.lastError;
  });
}

/* ------------------------------------------------------------------ */
/* Mesaje                                                              */
/* ------------------------------------------------------------------ */

async function handleMessage(message) {
  const type = message && message.type;

  if (type === 'options:open') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }

  if (type === 'ratings:resolve') {
    try {
      const found = await resolveImdbId(message.title);
      return found ? { ok: true, ...found } : { ok: false, error: { message: 'not found', code: 'NOT_FOUND' } };
    } catch (error) {
      return { ok: false, error: { message: String(error && error.message), code: 'ERROR' } };
    }
  }

  if (type === 'sources:test') {
    try {
      if (message.source) return { ok: true, results: { [message.source]: await testSource(message.source) } };
      return { ok: true, results: await testAllSources() };
    } catch (error) {
      return { ok: false, error: { message: String(error && error.message), code: 'ERROR' } };
    }
  }

  if (type === 'cache:clear') {
    try {
      const removed = await clearCaches();
      return { ok: true, removed };
    } catch (error) {
      return { ok: false, error: { message: String(error && error.message), code: 'ERROR' } };
    }
  }

  if (type === 'actor:films') {
    const name = String(message.name || '').trim();
    if (!name) return { ok: false, error: { message: 'no name', code: 'NO_NAME' } };
    const key = name.toLowerCase();
    const cache = await readJsonCache(ACTOR_CACHE_KEY);
    const cached = cache[key];
    if (!message.force && cached && Date.now() - (cached.at || 0) < (await cacheTtlMs())) {
      return { ok: true, cached: true, ...cached.data };
    }
    try {
      const result = await fetchActorFilms(name);
      if (!result.films) return { ok: false, error: { message: result.reason || 'error', code: 'ERROR' } };
      cache[key] = { at: Date.now(), data: result };
      await writeJsonCache(ACTOR_CACHE_KEY, cache, ACTOR_MAX_ENTRIES);
      return { ok: true, cached: false, ...result };
    } catch (error) {
      return { ok: false, error: { message: String(error && error.message), code: 'ERROR' } };
    }
  }

  if (type === 'ratings:get') {
    const imdbId = FL.normalizeImdbId(message.imdbId);
    if (!imdbId) return { ok: false, error: { message: 'no imdb id', code: 'NO_ID' } };

    if (!message.force) {
      const cached = (await readCache())[imdbId];
      if (cached && Date.now() - (cached.at || 0) < (await cacheTtlMs())) {
        return {
          ok: true,
          cached: true,
          imdbId,
          title: cached.title,
          ratings: cached.ratings || {},
          missing: cached.missing || {},
        };
      }
    }

    try {
      const result = await collectRatings(imdbId, message.title || '');
      await writeCache(result);
      return { ok: true, cached: false, ...result };
    } catch (error) {
      return { ok: false, error: { message: String(error && error.message), code: 'ERROR' } };
    }
  }

  return { ok: false, error: { message: 'Mesaj necunoscut: ' + String(type), code: 'UNKNOWN' } };
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== 'fl-search-selection') return;
    const query = String(info.selectionText || '').replace(/\s+/g, ' ').trim();
    if (!query) return;
    chrome.tabs.create({ url: 'https://filelist.io/browse.php?search=' + encodeURIComponent(query.slice(0, 150)) });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[FL.SETTINGS_KEY]) ensureContextMenu();
});

ensureContextMenu();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(
    (result) => sendResponse(result),
    (error) => sendResponse({ ok: false, error: { message: String(error && error.message), code: 'ERROR' } }),
  );
  return true;
});
