// Google Ads tag (gtag.js) for YouTube traffic only.
//
// Reads the ab_source cookie set by /api/redirect. If the visitor came in
// through {{PUBLIC_URL}}/yt (YouTube ads), this script loads
// gtag.js and registers the AW-16902338291 conversion ID. Meta traffic does
// nothing — the script is a no-op so Google Ads only sees YouTube visitors.
//
// To fire a conversion (e.g. on the gracias-calificado page), add the
// `data-conversion="LABEL"` attribute on the <script> tag. The conversion
// will only fire when ab_source=youtube AND after gtag has loaded.
(function () {
  var AW_ID = 'AW-16902338291';

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  if (getCookie('ab_source') !== 'youtube') return;

  // Resolve the current <script> tag so we can read data-conversion before
  // the async gtag.js load races us.
  var me = document.currentScript;
  var conversionLabel = me && me.getAttribute('data-conversion');

  // Bootstrap dataLayer + gtag stub before the async script loads.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  gtag('js', new Date());
  gtag('config', AW_ID);

  if (conversionLabel) {
    gtag('event', 'conversion', { send_to: AW_ID + '/' + conversionLabel });
  }

  // Inject gtag.js (async). dataLayer queue above guarantees the config /
  // conversion calls execute as soon as gtag.js is ready.
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + AW_ID;
  document.head.appendChild(s);
})();
