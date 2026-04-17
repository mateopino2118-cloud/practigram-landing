/* ============================================================
   Exit Intent Popup — componente unificado
   Funciona en desktop (mouseout) y mobile (scroll velocity + back button).
   Best practices: time-on-page mínimo, scroll depth, sessionStorage cap,
   tracking integrado con /api/track.

   Uso (insertar antes de </body>):

     <link rel="stylesheet" href="/css/exit-popup.css">
     <script src="/js/exit-popup.js"
       data-variant="v8"
       data-headline="Esperá — tu resultado está casi listo"
       data-sub="Ya respondiste el quiz. No te vayas sin tu score y diagnóstico personalizado."
       data-cta="SÍ, VER MI RESULTADO"
       data-decline="Cerrar"
       data-icon="⚡"
       data-target-selector="a[onclick*='openPopup'], .cta, #ctaPrimary"
       data-min-time="15"
       data-min-scroll="25"></script>

   Atributos opcionales:
     data-variant         (string)  ID variante para tracking. Default: lo lee del meta o usa "unknown"
     data-headline        (string)  Título del popup
     data-sub             (string)  Sub-copy. Soporta <strong> embebido
     data-cta             (string)  Texto del botón principal
     data-decline         (string)  Texto del decline link. Default: "Cerrar"
     data-icon            (string)  Emoji o caracter del icono. Default: "⚡"
     data-target-selector (string)  CSS selector del CTA al que el popup hace scroll/click. Default: ".cta"
     data-min-time        (number)  Segundos mínimos antes de armar trigger. Default: 15
     data-min-scroll      (number)  Porcentaje mínimo de scroll antes de armar. Default: 25
     data-disable-mobile  ("true")  Deshabilitar en mobile (no recomendado)
   ============================================================ */

(function () {
  if (window.__apExitPopupInited) return;
  window.__apExitPopupInited = true;

  // ----- Read config from script tag -----
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('exit-popup.js') !== -1) return scripts[i];
    }
    return null;
  })();
  if (!script) return;

  var cfg = {
    variant:        script.getAttribute('data-variant') || (function () {
      var meta = document.querySelector('meta[name="ap-variant"]');
      return meta ? meta.getAttribute('content') : 'unknown';
    })(),
    headline:       script.getAttribute('data-headline') || 'Antes de irte…',
    sub:            script.getAttribute('data-sub')      || 'Hoy a las 8PM hay clase gratis por Zoom. Lugares limitados.',
    cta:            script.getAttribute('data-cta')      || 'SÍ, QUIERO MI LUGAR',
    decline:        script.getAttribute('data-decline')  || 'Salir igual',
    icon:           script.getAttribute('data-icon')     || '⚡',
    targetSelector: script.getAttribute('data-target-selector') || '',
    minTime:        parseInt(script.getAttribute('data-min-time')   || '15', 10) * 1000,
    minScroll:      parseInt(script.getAttribute('data-min-scroll') || '25', 10),
    disableMobile:  script.getAttribute('data-disable-mobile') === 'true',
    // Theme tokens (overridable via data-*; default sane fallbacks)
    theme: {
      bg:           script.getAttribute('data-bg')           || '',
      ink:          script.getAttribute('data-ink')          || '',
      mute:         script.getAttribute('data-mute')         || '',
      strong:       script.getAttribute('data-strong')       || '',
      accent:       script.getAttribute('data-accent')       || '',
      accentInk:    script.getAttribute('data-accent-ink')   || '',
      accentShadow: script.getAttribute('data-accent-shadow')|| '',
      font:         script.getAttribute('data-font')         || '',
      headlineFont: script.getAttribute('data-headline-font')|| '',
      backdrop:     script.getAttribute('data-backdrop')     || '',
      border:       script.getAttribute('data-border')       || '',
      radius:       script.getAttribute('data-radius')       || '',
      ctaRadius:    script.getAttribute('data-cta-radius')   || '',
      ctaTransform: script.getAttribute('data-cta-transform')|| '',
      decline:      script.getAttribute('data-decline-color')|| ''
    }
  };

  // ----- Per-page-load only (NO sessionStorage / cookies) -----
  // Spec del usuario: el popup debe aparecer cada vez que la persona
  // entre a la página (nueva carga = nueva oportunidad), pero no más
  // de una vez dentro de la misma carga. La variable in-memory `shown`
  // alcanza para esto: muere cuando refrescan / cierran tab / vuelven.

  // ----- Timing A/B test (mobile only) -----
  // Métrica primaria: % de conversión global por bucket. Cada visitante mobile
  // cae en uno de 5 grupos: control (50%, popup con gates clásicos) o 4 buckets
  // de timing forzado (12.5% c/u: 500/1000/2000/3000ms). El bucket se persiste
  // en sessionStorage para sobrevivir a la navegación landing → gracias-* y se
  // emite como `impression_b{bucket}` al cargar; gracias-*.html lee el mismo
  // bucket y emite `conversion_b{bucket}`. stats.js agrega ambos y computa
  // conv_rate = conv_b{bucket} / imp_b{bucket}. Desktop queda fuera del test.
  var IS_MOBILE = /Mobi|Android|iPhone|iPod|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent || '');
  // Ronda 2: descartamos 3000ms (sólo el más lento, que el histograma de
  // dwell confirma que cae fuera del pico de abandono) y lo reemplazamos
  // por 1550ms. 50% control, 50% test split uniforme entre 500 / 1000 /
  // 1550 / 2000 ms. Data previa fue reseteada para arrancar con todos los
  // buckets en el mismo punto de partida.
  var TIMING_BUCKETS = ['500', '1000', '1550', '2000'];
  var VALID_BUCKETS = { '500': 1, '1000': 1, '1550': 1, '2000': 1, 'control': 1 };
  var timingBucket = null; // null = no asignado (desktop o test deshabilitado)
  if (IS_MOBILE && script.getAttribute('data-timing-test') !== 'false') {
    try { timingBucket = sessionStorage.getItem('apTimingBucket'); } catch (e) {}
    // Si el visitante tenía un bucket viejo (1000/3000) reasignamos.
    if (timingBucket && !VALID_BUCKETS[timingBucket]) timingBucket = null;
    if (!timingBucket) {
      if (Math.random() < 0.5) {
        timingBucket = TIMING_BUCKETS[Math.floor(Math.random() * TIMING_BUCKETS.length)];
      } else {
        timingBucket = 'control';
      }
      try { sessionStorage.setItem('apTimingBucket', timingBucket); } catch (e) {}
    }
    // Exposición: cada page-load del visitante cuenta como una "impresión"
    // dentro de su bucket. La conversión por bucket se calcula contra este
    // denominador en stats.js.
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'impression_b' + timingBucket, variant: cfg.variant }),
        keepalive: true
      });
    } catch (e) { /* noop */ }
  }

  // ----- Debug mode (?exitDebug=1) -----
  var DEBUG = /[?&]exitDebug=1/.test(location.search);
  var dbgEl = null;
  function dbgLog() {
    if (!DEBUG) return;
    if (!dbgEl) {
      dbgEl = document.createElement('div');
      dbgEl.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#000;color:#0f0;font:11px/1.4 monospace;padding:8px 12px;z-index:999998;white-space:pre-wrap;max-height:40vh;overflow:auto;';
      if (document.body) document.body.appendChild(dbgEl);
      else document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(dbgEl); });
    }
    var st = {
      t:        ((Date.now() - pageLoadedAt)/1000).toFixed(1)+'s / '+(cfg.minTime/1000)+'s',
      scroll:   getScrollPct()+'% / '+cfg.minScroll+'% (scrollable:'+isPageScrollable()+')',
      interact: hasInteracted,
      armed:    armed,
      shown:    shown,
      mouseY:   (window.__apLastMouseY != null ? window.__apLastMouseY : 'n/a')
    };
    var lines = [];
    for (var k in st) lines.push(k.padEnd(9)+': '+st[k]);
    dbgEl.textContent = '[exit-popup debug]\n' + lines.join('\n') + '\n\n(per-page-load mode: refrescá para resetear)';
  }

  // ----- Tracking helper -----
  // Cuando hay un bucket de timing asignado, emitimos DOS eventos por acción:
  //   1) el tipo base (p.ej. "exit_popup_shown") — para que el card existente
  //      del dashboard siga funcionando sin cambios
  //   2) el tipo bucketeado ("exit_popup_shown_b500") — para el card nuevo
  //      de "timing test" que desglosa por bucket
  // Sin bucket (desktop/control) sólo emite el tipo base.
  function track(type) {
    _send(type);
    if (timingBucket) _send(type + '_b' + timingBucket);
  }
  function _send(type, value) {
    try {
      var body = { type: type, variant: cfg.variant };
      if (typeof value === 'number') body.value = value;
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      });
    } catch (e) { /* noop */ }
  }

  // ----- Dwell time tracking (independiente del timing test) -----
  // Medimos los milisegundos exactos que pasa cada visitante en la landing
  // antes de irse (cierra pestaña, cambia de app, navega, da atrás). Un
  // único evento por page-load, al primer `pagehide` o `visibilitychange →
  // hidden` — pagehide es el confiable en mobile, visibilitychange backup.
  //
  // El ms exacto va en `value` (columna value_int de la tabla events); el
  // tipo es sólo `dwell_c` (convirtió) o `dwell_u` (se fue sin convertir).
  // La bandera de conversión viene de sessionStorage, seteada por un
  // listener de submit delegado a nivel document — así no dependemos del
  // markup de cada variante.
  var pageStartedAt = Date.now();
  var dwellSent = false;
  function sendDwell() {
    if (dwellSent) return;
    dwellSent = true;
    var elapsed = Date.now() - pageStartedAt;
    if (elapsed < 50) return; // descartar reloads instantáneos (ruido)
    var converted = false;
    try { converted = sessionStorage.getItem('apConverted') === '1'; } catch (e) {}
    _send(converted ? 'dwell_c' : 'dwell_u', elapsed);
  }
  // Marcar conversión cuando se envía cualquier form en la landing. Esto
  // corre ANTES del navigate a gracias-*, así el pagehide posterior lee
  // el flag correcto. Delegado a document para no depender del id del form.
  document.addEventListener('submit', function () {
    try { sessionStorage.setItem('apConverted', '1'); } catch (e) {}
  }, true);
  window.addEventListener('pagehide', sendDwell);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendDwell();
  });

  // ----- Inject HTML -----
  function buildPopup() {
    var wrap = document.createElement('div');
    wrap.id = 'apExitPopup';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'apExitHeadline');

    // Apply per-variant theme via CSS custom properties (inline style).
    // Sólo se setean las que la variante haya provisto en data-* — el resto
    // hereda los defaults del CSS.
    var t = cfg.theme;
    var style = '';
    if (t.bg)           style += '--ap-bg:'           + t.bg + ';';
    if (t.ink)          style += '--ap-ink:'          + t.ink + ';';
    if (t.mute)         style += '--ap-mute:'         + t.mute + ';';
    if (t.strong)       style += '--ap-strong:'       + t.strong + ';';
    if (t.accent)       style += '--ap-accent:'       + t.accent + ';';
    if (t.accentInk)    style += '--ap-accent-ink:'   + t.accentInk + ';';
    if (t.accentShadow) style += '--ap-accent-shadow:'+ t.accentShadow + ';';
    if (t.font)         style += '--ap-font:'         + t.font + ';';
    if (t.headlineFont) style += '--ap-headline-font:'+ t.headlineFont + ';';
    if (t.backdrop)     style += '--ap-backdrop:'     + t.backdrop + ';';
    if (t.border)       style += '--ap-border:'       + t.border + ';';
    if (t.radius)       style += '--ap-radius:'       + t.radius + ';';
    if (t.ctaRadius)    style += '--ap-cta-radius:'   + t.ctaRadius + ';';
    if (t.ctaTransform) style += '--ap-cta-transform:'+ t.ctaTransform + ';';
    if (t.decline)      style += '--ap-decline:'      + t.decline + ';';
    if (style) wrap.setAttribute('style', style);

    wrap.innerHTML =
      '<div class="ap-exit-box">' +
        '<button class="ap-exit-close" type="button" aria-label="Cerrar">&times;</button>' +
        '<div class="ap-exit-icon" aria-hidden="true">' + escapeHtml(cfg.icon) + '</div>' +
        '<h3 class="ap-exit-headline" id="apExitHeadline">' + escapeHtml(cfg.headline) + '</h3>' +
        '<p class="ap-exit-sub">' + cfg.sub + '</p>' + // sub permite HTML embebido (strong)
        '<button class="ap-exit-cta" type="button">' + escapeHtml(cfg.cta) + '</button>' +
        '<button class="ap-exit-decline" type="button">' + escapeHtml(cfg.decline) + '</button>' +
      '</div>';
    document.body.appendChild(wrap);
    return wrap;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ----- Show / hide -----
  var popupEl = null;
  var shown = false;

  function show() {
    if (shown) return;
    shown = true;
    if (!popupEl) popupEl = buildPopup();
    popupEl.classList.add('ap-show');
    document.body.style.overflow = 'hidden';
    track('exit_popup_shown');

    // Bind handlers
    var close = popupEl.querySelector('.ap-exit-close');
    var cta   = popupEl.querySelector('.ap-exit-cta');
    var dec   = popupEl.querySelector('.ap-exit-decline');
    close.addEventListener('click', function () { hide('dismissed'); });
    dec.addEventListener('click',   function () { hide('dismissed'); });
    cta.addEventListener('click',   function () {
      track('exit_popup_recovered');
      hide('recovered');
      // Si data-target-selector está definido, scrollea + clickea ese target.
      // Si NO está definido, simplemente cerramos el popup y dejamos al
      // usuario donde estaba (caso quiz: vuelve a la pregunta donde iba).
      if (!cfg.targetSelector) return;
      var target = document.querySelector(cfg.targetSelector);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (target.tagName === 'BUTTON' || (target.tagName === 'A' && target.getAttribute('onclick'))) {
          setTimeout(function () { try { target.click(); } catch (e) {} }, 600);
        }
      }
    });

    // ESC para cerrar
    document.addEventListener('keydown', escClose);
  }

  function hide(reason) {
    if (!popupEl) return;
    popupEl.classList.remove('ap-show');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', escClose);
    if (reason === 'dismissed') track('exit_popup_dismissed');
  }
  function escClose(e) { if (e.key === 'Escape') hide('dismissed'); }

  // ----- Trigger arming -----
  var pageLoadedAt = Date.now();
  var armed = false;
  var hasInteracted = false;

  // Cualquier interacción real del usuario cuenta como engagement.
  // Útil para SPAs (como quizzes con screens absolutos) donde no hay scroll real.
  ['click', 'touchstart', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function () { hasInteracted = true; }, { passive: true, once: false });
  });

  function isArmed() {
    if (armed) return true;
    var elapsed = Date.now() - pageLoadedAt;
    if (elapsed < cfg.minTime) return false;
    // Engagement check: scroll OR interacción del usuario.
    // Si la página no es scrolleable (SPA/quiz), basta con que haya interactuado.
    var scrollable = isPageScrollable();
    if (scrollable) {
      if (getScrollPct() < cfg.minScroll && !hasInteracted) return false;
    } else {
      if (!hasInteracted) return false;
    }
    armed = true;
    return true;
  }
  function isPageScrollable() {
    var scrollHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    var clientHeight = window.innerHeight || document.documentElement.clientHeight;
    return (scrollHeight - clientHeight) > 100;
  }
  function getScrollPct() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
    var scrollHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
    var clientHeight = window.innerHeight || document.documentElement.clientHeight;
    var scrollable = scrollHeight - clientHeight;
    if (scrollable <= 0) return 100; // página no scrolleable: la consideramos "fully read"
    return Math.min(100, Math.round((scrollTop / scrollable) * 100));
  }

  // ----- Desktop trigger: mouseout top -----
  function onMouseMove(e) { window.__apLastMouseY = e.clientY; }
  function onMouseOut(e) {
    window.__apLastMouseY = e.clientY;
    if (DEBUG) dbgLog();
    if (!isArmed()) return;
    if (e.clientY > 8) return;
    if (e.relatedTarget || e.toElement) return;
    show();
  }

  // ----- Mobile trigger: scroll velocity hacia arriba -----
  var lastScrollY = window.pageYOffset || 0;
  var lastScrollT = Date.now();
  function onScroll() {
    if (!isArmed()) return;
    var now = Date.now();
    var y = window.pageYOffset || 0;
    var dt = now - lastScrollT;
    var dy = y - lastScrollY;
    // Velocidad upward >= 2px/ms (= 200px en 100ms) Y por encima de la mitad superior
    if (dt > 0 && dy < -120 && dt < 100 && y < 200) {
      show();
    }
    lastScrollY = y;
    lastScrollT = now;
  }

  // ----- Mobile trigger: back button intercept -----
  function setupBackButtonTrap() {
    if (cfg.disableMobile) return;
    if (!('history' in window) || typeof history.pushState !== 'function') return;
    try {
      history.pushState({ apExitTrap: true }, '', location.href);
      window.addEventListener('popstate', function () {
        if (isArmed() && !shown) {
          show();
          // Re-pushear para que el back tenga otro efecto
          try { history.pushState({ apExitTrap: true }, '', location.href); } catch (e) {}
        }
      });
    } catch (e) { /* silent */ }
  }

  // ----- Init -----
  function init() {
    // Timing test (mobile): si el bucket es uno de los timings forzados,
    // mostramos el popup al X ms exacto saltándonos todos los gates. El
    // bucket "control" cae al flujo normal (gates clásicos) más abajo.
    if (timingBucket && timingBucket !== 'control') {
      var delay = parseInt(timingBucket, 10);
      setTimeout(function () {
        armed = true;
        show();
      }, delay);
      // NO registramos mouseout/scroll/back-button handlers en el grupo test:
      // el único trigger es el timer. Esto aísla la señal del bucket.
      return;
    }
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    document.addEventListener('mouseout', onMouseOut, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    setupBackButtonTrap();
    if (DEBUG) {
      dbgLog();
      setInterval(dbgLog, 500);
      // En modo debug, también ofrecemos un botón forzador
      var btn = document.createElement('button');
      btn.textContent = 'FORZAR EXIT POPUP';
      btn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;background:#dc2626;color:#fff;border:none;padding:10px 14px;font:bold 12px sans-serif;border-radius:8px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      btn.onclick = function () {
        // En modo debug, permite re-disparar el popup sin refrescar
        if (popupEl) { popupEl.classList.remove('ap-show'); document.body.style.overflow = ''; }
        shown = false;
        show();
      };
      if (document.body) document.body.appendChild(btn);
      else document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(btn); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
