/**
 * einstein.js — Conecta practigram-landing con el dashboard Einstein (ad-machine).
 *
 * 1. Al cargar la página: registra la visita en Einstein (con UTMs del ad).
 * 2. Al hacer submit del #regForm: registra el lead en Einstein (upsert por email).
 *
 * Ambas llamadas son fire-and-forget (keepalive:true) — nunca bloquean la
 * navegación ni el redirect a WhatsApp.
 */
(function () {
  var EINSTEIN = 'https://joacocamara.com';

  // ── Lee los UTMs de la URL actual ─────────────────────────────────────────
  function getUTMs() {
    try {
      var p = new URLSearchParams(window.location.search);
      return {
        utm_source:   p.get('utm_source')   || null,
        utm_medium:   p.get('utm_medium')   || null,
        utm_campaign: p.get('utm_campaign') || null,
        utm_content:  p.get('utm_content')  || null,
        utm_term:     p.get('utm_term')     || null,
      };
    } catch (_) { return {}; }
  }

  // ── 1. Pageview ───────────────────────────────────────────────────────────
  try {
    fetch(EINSTEIN + '/api/meta/track/pageview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: window.location.href }),
      keepalive: true,
    }).catch(function () {});
  } catch (_) {}

  // ── 2. Lead al submit del form ────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('regForm');
    if (!form) return;

    form.addEventListener('submit', function () {
      // No llamamos e.preventDefault() — dejamos que el handler original corra.
      // Este listener solo dispara la llamada a Einstein en paralelo.
      try {
        var nombre = (document.getElementById('f_nombre') || {}).value || '';
        var email  = (document.getElementById('f_email')  || {}).value || '';
        if (!email) return;

        var utms = getUTMs();
        fetch(EINSTEIN + '/api/meta/lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nombre:       nombre,
            email:        email,
            url:          window.location.href,
            utm_source:   utms.utm_source,
            utm_medium:   utms.utm_medium,
            utm_campaign: utms.utm_campaign,
            utm_content:  utms.utm_content,
            utm_term:     utms.utm_term,
          }),
          keepalive: true,
        }).catch(function () {});
      } catch (_) {}
    }, true); // capture:true → corre antes del handler del form
  });
})();
