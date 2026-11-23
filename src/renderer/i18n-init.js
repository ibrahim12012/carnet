'use strict';
// Language of the window, set before the other scripts run: they use t() and tn(), and the static text of
// index.html (written in English) is translated here once.
(function () {
  const lang = i18n.setLang((window.api && window.api.lang) || 'en');
  document.documentElement.lang = lang;
  i18n.translateDom(document.body);
  window.t = i18n.t;
  window.tn = i18n.tn;
})();
