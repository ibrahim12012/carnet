'use strict';
// Translations. The app is written in English; each other language is a dictionary from the English text to
// its translation (src/i18n/fr.js, es.js, de.js). Shared by the main process (require), the window (<script>)
// and the phone page (the server injects the strings it needs).
//   t('Saved in {where}', { where }) : translated text, with {name} placeholders filled in.
//   translateDom(root) : translates the static text of a page written in English (text, title, placeholder…).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.i18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LANGS = [
    { code: 'en', name: 'English', english: 'English', locale: 'en-GB', quotes: ['“', '”'] },
    { code: 'fr', name: 'Français', english: 'French', locale: 'fr-FR', quotes: ['« ', ' »'] },
    { code: 'es', name: 'Español', english: 'Spanish (Spain)', locale: 'es-ES', quotes: ['«', '»'] },
    { code: 'de', name: 'Deutsch', english: 'German', locale: 'de-DE', quotes: ['„', '“'] },
  ];
  const dicts = {};
  let lang = 'en', dict = null;

  function register(code, table) { dicts[code] = table; if (code === lang) dict = table; }
  function setLang(code) {
    lang = LANGS.some((l) => l.code === code) ? code : 'en';
    dict = lang === 'en' ? null : dicts[lang] || null;
    return lang;
  }
  const info = (code) => LANGS.find((l) => l.code === (code || lang)) || LANGS[0];

  function t(src, vars) {
    let s = (dict && dict[src]) || src;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
    return s;
  }
  // Number + noun: tn(n, '{n} video', '{n} videos'). The plural rule is the language's (in French, 0 and 1 are
  // singular).
  const rules = {};
  const isOne = (n) => {
    const l = info().locale;
    try { return (rules[l] || (rules[l] = new Intl.PluralRules(l))).select(n) === 'one'; } catch (_) { return n === 1; }
  };
  const tn = (n, one, many, vars) => t(isOne(n) ? one : many, { n, ...(vars || {}) });

  // Static text of a page: text nodes, a few attributes, and elements marked data-i18n-html whose whole
  // content (with its tags) is one sentence.
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip'];
  function translateDom(rootNode) {
    if (!dict || !rootNode) return;
    const doc = rootNode.ownerDocument || rootNode;
    rootNode.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html') || el.innerHTML.trim();
      if (!el.hasAttribute('data-i18n-html') || !el.getAttribute('data-i18n-html')) el.setAttribute('data-i18n-html', key);
      if (dict[key]) el.innerHTML = dict[key];
    });
    const walker = doc.createTreeWalker(rootNode, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const p = n.parentNode;
      if (!p || p.closest && p.closest('[data-i18n-html], script, style, [data-no-i18n]')) continue;
      const raw = n.nodeValue, key = raw.trim();
      if (key && dict[key]) n.nodeValue = raw.replace(key, dict[key]);
    }
    rootNode.querySelectorAll('*').forEach((el) => {
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && dict[v.trim()]) el.setAttribute(a, dict[v.trim()]);
      }
    });
  }

  const api = {
    LANGS, register, setLang, t, tn, translateDom, info,
    get lang() { return lang; },
    get locale() { return info().locale; },
    // Quotation marks of the language, for the person's own words (« … » in French, “…” in English).
    quote: (s) => info().quotes[0] + s + info().quotes[1],
    // Dictionary limited to the keys a text uses (the phone page receives only its own strings).
    subset(code, text) {
      const d = dicts[code];
      if (!d) return {};
      const out = {};
      for (const k of Object.keys(d)) if (text.includes(k)) out[k] = d[k];
      return out;
    },
  };
  // In Node (main process), the dictionaries are loaded right away; in the window, each one is its own <script>.
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    for (const l of LANGS) if (l.code !== 'en') { try { register(l.code, require('./' + l.code)); } catch (_) {} }
  }
  return api;
});
