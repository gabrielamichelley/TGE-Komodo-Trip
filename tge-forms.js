/* =====================================================================
   TGE website forms → TGE Lead Collector (Google Apps Script)
   Replaces Formspree. Every signup is saved to the TGE Lead List sheet
   and added to the matching Sender group (which starts the emails).

   Safety nets:
   - each submission gets an ID, so retries never create duplicates
   - a copy is kept in the visitor's browser until the server confirms,
     and is re-sent automatically on her next page view if anything failed
   ===================================================================== */
(function () {
  var ENDPOINT = 'https://script.google.com/macros/s/AKfycbw_VZ2f4DyQwTRKIftPpTCRq9Q7W605o4Eg9mydpDi5lpZBTZu1WtIjX2GdTOKPDB8r/exec';
  var QUEUE_KEY = 'tgeLeadQueue';
  var FAST_MS = 900;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Clarity: tag this visitor's recording with an anonymous lead ID so it can be found later.
  // ID = 'lead_' + first 16 hex chars of SHA-256(lowercased email). Same formula as the 'Clarity ID'
  // column in the TGE Lead List sheet. The raw email is never sent to Clarity.
  function identifyInClarity(email) {
    try {
      var e = String(email || '').trim().toLowerCase();
      if (typeof window.clarity !== 'function' || !EMAIL_RE.test(e)) return;
      if (!(window.crypto && window.crypto.subtle && window.TextEncoder)) return;
      window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(e)).then(function (buf) {
        var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        window.clarity('identify', 'lead_' + hex.slice(0, 16), null, null, 'Lead');
        window.clarity('set', 'lead', 'yes');
        window.clarity('event', 'lead_identified');
      }).catch(function () {});
    } catch (err) {}
  }
  window.TGE_LEAD_ENDPOINT = ENDPOINT;

  var store = {
    get: function () { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } },
    set: function (q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {} }
  };
  function sid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

  function toParams(data) {
    var out = {};
    if (data && typeof FormData !== 'undefined' && data instanceof FormData) {
      data.forEach(function (v, k) { if (typeof v === 'string') out[k] = out[k] ? out[k] + ', ' + v : v; });
    } else if (data && data.tagName === 'FORM') {
      return toParams(new FormData(data));
    } else if (data) {
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = String(data[k]);
    }
    return out;
  }

  function post(fields) {
    var body = new URLSearchParams(fields);
    return fetch(ENDPOINT, { method: 'POST', body: body, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || 'not saved'); return { ok: true }; })
      .catch(function (err) {
        if (err && err.message && err.message !== 'Failed to fetch' && !/NetworkError|Load failed|JSON|Unexpected/i.test(err.message)) throw err;
        // response could not be read (network/CORS hiccup): send again in no-cors mode.
        // The server ignores the copy if the first one arrived (same submission ID).
        return fetch(ENDPOINT, { method: 'POST', body: new URLSearchParams(fields), mode: 'no-cors' })
          .then(function () { return { ok: true, unconfirmed: true }; });
      });
  }

  function dequeue(id) { store.set(store.get().filter(function (x) { return x.f._sid !== id; })); }

  /**
   * Send a signup. `data` = a <form>, a FormData, or a plain object.
   * Resolves { ok: true } as soon as it's saved, or after ~1 second at most (it keeps sending in the
   * background and is re-sent on her next page view if needed). Rejects only for an invalid email.
   */
  window.tgeSendLead = function (data, formId) {
    var f = toParams(data);
    if (formId) f.form_id = formId;
    f._sid = f._sid || sid();
    f._page = location.href;
    f._ajax = '1';
    if (!EMAIL_RE.test(String(f.email || '').trim())) return Promise.reject(new Error('invalid email'));
    identifyInClarity(f.email);
    var q = store.get(); q.push({ f: f, tries: 0 }); store.set(q.slice(-20));
    var sending = post(f).then(function (r) { if (!r.unconfirmed) dequeue(f._sid); return r; });
    // Don't keep her waiting: show success after at most FAST_MS. The request carries on in the
    // background, and if it somehow fails it is re-sent on her next page view.
    var fast = new Promise(function (res) { setTimeout(function () { res({ ok: true, background: true }); }, FAST_MS); });
    return Promise.race([sending.catch(function () { return { ok: true, background: true }; }), fast]);
  };

  // re-send anything that didn't get through last time
  function flush() {
    var q = store.get();
    if (!q.length) return;
    q.forEach(function (item) { item.tries = (item.tries || 0) + 1; });
    store.set(q.filter(function (item) { return item.tries <= 5; }));
    q.forEach(function (item) {
      if (item.tries > 5) return;
      post(item.f).then(function (r) { if (!r.unconfirmed) dequeue(item.f._sid); }).catch(function () {});
    });
  }

  // Plain HTML forms (register interest + contact forms): send in the background, stay on the page.
  function bindForms() {
    var forms = document.querySelectorAll('form[data-tge-form]');
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = form.querySelector('[type="submit"]');
        var label = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = 'Sending…'; }
        window.tgeSendLead(new FormData(form), form.getAttribute('data-tge-form'))
          .then(function () {
            form.reset();
            if (btn) btn.innerHTML = '✓ Thank you! We’ll be in touch soon';
          })
          .catch(function () {
            if (btn) { btn.disabled = false; btn.innerHTML = label; }
            var msg = form.querySelector('.tge-form-err');
            if (!msg) {
              msg = document.createElement('p');
              msg.className = 'tge-form-err';
              msg.style.cssText = 'text-align:center;font-size:0.8rem;color:#b5523b;margin:0.4rem 0 0;';
              msg.textContent = 'Something went wrong, please try again or message us on WhatsApp.';
              form.appendChild(msg);
            }
          });
      });
    });
  }

  function start() { bindForms(); setTimeout(flush, 2500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
