/* =====================================================================
   TGE TRACKING — one shared file for every page (homepage + trip pages)
   Meta Pixel + TikTok + Microsoft Clarity events, all in one place.

   What it does
   - Tags every Clarity recording with trip, ad campaign/ad ID, source,
     and whether the visitor is inside the Instagram/Facebook app
   - ViewContent (with price) on trip pages
   - InitiateCheckout ONCE per page view when Book Now is clicked
     (no more duplicates from every button), with value + currency
   - Watches the WeTravel booking pop-up: how long it stayed open,
     whether the visitor actually typed/clicked inside it, and whether
     it moved to another step — sent to Clarity + Meta as custom events
   - Brochure buttons = "BrochureClick" (a click is not a lead yet)
   - Any form with an email = Clarity "identify", so the recording shows
     the person's name and you can match it to your lead list
   - WhatsApp / live chat clicks as Clarity events

   - Google Ads: Purchase (with value, transaction ID + enhanced
     conversions email), Begin Checkout and Lead conversions, plus the
     standard GA4-style events (begin_checkout / generate_lead / purchase)

   Debug: open any page with ?tgedebug=1 and watch the browser console.
   In debug mode EVERY message the WeTravel pop-up sends is printed, so a
   test booking shows exactly which step messages WeTravel emits.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tgeTracking) return;
  window.__tgeTracking = true;

  var DEBUG = /[?&]tgedebug=1/.test(location.search);
  function log() { if (DEBUG && window.console) console.log.apply(console, ['[TGE]'].concat([].slice.call(arguments))); }

  /* ---------- Trip config (prices in USD, per person) ----------
     sale = Black Friday price until SALE_ENDS, then the normal price.
     Used for ViewContent / Book Now values. Purchases use the REAL amount WeTravel reports. */
  var path = location.pathname.toLowerCase();
  var SALE_ENDS = Date.UTC(2026, 11, 1, 8, 0, 0);   // 30 Nov 2026 23:59 US Pacific (matches the page schema)
  var onSale = Date.now() < SALE_ENDS;
  var TRIPS = {
    maldives: { id: '0360814720', name: 'Maldives Girls Retreat', value: onSale ? 1799 : 2199 },
    bali:     { id: '6779947278', name: 'ISLAND LIFE Bali',       value: onSale ? 599 : 799 },
    komodo:   { id: '9867630528', name: 'Becoming HER Komodo',    value: onSale ? 1199 : 1299 }
  };
  var tripKey = path.indexOf('maldives') > -1 ? 'maldives'
              : path.indexOf('bali') > -1 ? 'bali'
              : path.indexOf('komodo') > -1 ? 'komodo' : null;
  var trip = tripKey ? TRIPS[tripKey] : null;
  var pageType = trip ? 'trip' : (path === '/' || path.indexOf('index') > -1 ? 'home' : 'other');

  /* ---------- Safe wrappers ---------- */
  function clarity() { try { if (window.clarity) window.clarity.apply(null, arguments); } catch (e) {} }
  function fb() { try { if (window.fbq) window.fbq.apply(null, arguments); } catch (e) {} }
  function tt(evt, data) { try { if (window.ttq && window.ttq.track) window.ttq.track(evt, data || {}); } catch (e) {} }
  /* TikTok's current event format: a "contents" list (top-level content_id is deprecated -> "Missing content_id" warning) */
  function ttData(id, name, value, cur) {
    return { contents: [{ content_id: String(id || ''), content_type: 'product', content_name: name || '' }], content_type: 'product', value: Number(value) || 0, currency: cur || 'USD' };
  }
  /* Google Ads conversion tracking (Google Ads > Goals > Conversions).
     purchaseLabel  = "Purchase" conversion action (primary - what bidding optimises for)
     checkoutLabel  = "Begin Checkout" action (set as SECONDARY in Google Ads) - paste label when created
     leadLabel      = "Lead" action (set as SECONDARY) - paste label when created
     The Google tag itself is loaded in each page's <head>; this only loads it if a page is missing it. */
  var GADS = { id: 'AW-18590926472', purchaseLabel: '3800CP2I3b0dEIiN7KBF', checkoutLabel: 'a10UCIuCs74dEIiN7KBF', leadLabel: 'vmbQCMe7tL4dEIiN7KBF' };
  if (GADS.id) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    if (!window.__tgeGtag) {
      window.__tgeGtag = 1;
      window.gtag('js', new Date()); window.gtag('config', GADS.id, { allow_enhanced_conversions: true });
      var gs = document.createElement('script'); gs.async = true; gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + GADS.id; document.head.appendChild(gs);
    }
  }
  function gads(label, data) { try { if (GADS.id && label && window.gtag) window.gtag('event', 'conversion', Object.assign({ send_to: GADS.id + '/' + label }, data || {})); log('google ads conversion', label, data); } catch (e) {} }
  /* GA4-style event (shows in Google tag diagnostics; also usable if GA4 is linked later) */
  function gev(name, data) { try { if (window.gtag) window.gtag('event', name, Object.assign({ send_to: GADS.id }, data || {})); log('google event', name, data); } catch (e) {} }
  function gItems(id, name, value) { return [{ item_id: String(id || ''), item_name: name || '', item_category: 'Group Trip', price: Number(value) || 0, quantity: 1 }]; }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function cEvent(name) { clarity('event', name); log('clarity event', name); }
  function cTag(k, v) { if (v === undefined || v === null || v === '') return; clarity('set', k, String(v).slice(0, 255)); log('clarity tag', k, v); }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }

  /* Clarity loads async — make sure calls queue even before it arrives */
  window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };

  /* ---------- Who / where from (stored for the whole visit) ---------- */
  var qs = {};
  location.search.replace(/^\?/, '').split('&').forEach(function (p) {
    var kv = p.split('='); if (kv[0]) { try { qs[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) {} }
  });
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
    if (qs[k]) ss('tge_' + k, qs[k]);
  });
  if (qs.fbclid) ss('tge_fbclid', '1');

  var ua = navigator.userAgent || '';
  var inApp = /Instagram/i.test(ua) ? 'instagram' : /FBAN|FBAV|FB_IAB/i.test(ua) ? 'facebook' : /TikTok|musical_ly|Bytedance/i.test(ua) ? 'tiktok' : 'no';
  var src = ss('tge_utm_source') || (document.referrer ? document.referrer.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : 'direct');

  cTag('page_type', pageType);
  cTag('trip', trip ? trip.name : 'none');
  cTag('in_app_browser', inApp);
  cTag('traffic_source', src);
  cTag('paid', ss('tge_utm_medium') === 'paid' || ss('tge_fbclid') ? 'yes' : 'no');
  cTag('ad_campaign_id', ss('tge_utm_campaign'));
  cTag('ad_set_id', ss('tge_utm_term'));
  cTag('ad_id', ss('tge_utm_content'));

  /* ---------- ViewContent on trip pages ---------- */
  function tripData(extra) {
    var d = { content_type: 'product', content_category: 'Group Trip', currency: 'USD' };
    if (trip) { d.content_ids = [trip.id]; d.content_name = trip.name; if (trip.value) d.value = trip.value; }
    for (var k in extra) d[k] = extra[k];
    return d;
  }
  if (trip) {
    fb('track', 'ViewContent', tripData());
    tt('ViewContent', ttData(trip.id, trip.name, trip.value));
  }

  /* ---------- Click tracking (one delegated listener) ---------- */
  var icSent = false, bookClicks = 0;

  function isBook(el) {
    return el.closest('.wtrvl-checkout_button, a[href*="wetravel.com/trips"], a[href*="wetravel.com/checkout"], a[href*="tri.ps/"], [data-book-now]');
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;

    var b = isBook(t);
    if (b) {
      bookClicks++;
      var where = b.id || String(b.className || '').split(' ').slice(-1)[0] || 'button';
      cEvent('book_now_click');
      cTag('book_button', where);
      cTag('clicked_book', 'yes');
      clarity('upgrade', 'book_now_click');            // keep this recording
      if (!icSent) {
        icSent = true;
        fb('track', 'InitiateCheckout', tripData({ num_items: 1 }));
        tt('InitiateCheckout', ttData(trip && trip.id, trip && trip.name, trip && trip.value));
        gads(GADS.checkoutLabel, { value: trip && trip.value ? trip.value : 0, currency: 'USD' });
        gev('begin_checkout', { value: trip && trip.value ? trip.value : 0, currency: 'USD', items: gItems(trip && trip.id, trip && trip.name, trip && trip.value) });
      } else {
        fb('trackCustom', 'BookNowRepeatClick', { clicks: bookClicks, content_name: trip ? trip.name : '' });
      }
      return;
    }

    if (t.closest('.wtrvl-download_brochure_button')) {
      cEvent('brochure_click');
      fb('trackCustom', 'BrochureClick', tripData());
      return;
    }

    var a = t.closest('a[href]');
    if (a) {
      var h = a.getAttribute('href') || '';
      if (/wa\.me|whatsapp/i.test(h)) { cEvent('whatsapp_click'); return; }
      if (/instagram\.com/i.test(h)) { cEvent('instagram_click'); return; }
      if (/^mailto:/i.test(h)) { cEvent('email_click'); return; }
    }
  }, true);

  /* Tawk.to live chat opened */
  window.Tawk_API = window.Tawk_API || {};
  var prevChat = window.Tawk_API.onChatStarted;
  window.Tawk_API.onChatStarted = function () { cEvent('live_chat_started'); fb('track', 'Contact', { content_name: 'Live chat' }); if (prevChat) try { prevChat.apply(this, arguments); } catch (e) {} };

  /* ---------- WeTravel booking pop-up watcher ----------
     The WeTravel checkout opens as an iframe on top of our page. We can't
     see inside it (it's WeTravel's site), but we CAN see: when it opens,
     whether the visitor taps inside it, if it loads a new step, and how
     long it stays open before they close it. */
  var co = null; // current checkout session
  function bucket(s) { return s < 10 ? '0-10s' : s < 30 ? '10-30s' : s < 60 ? '30-60s' : s < 180 ? '1-3min' : s < 600 ? '3-10min' : '10min+'; }

  function onCheckoutOpen(iframe) {
    if (co && co.iframe === iframe) return;
    co = { iframe: iframe, t0: Date.now(), loads: 0, engaged: false, closedSent: false };
    cEvent('checkout_opened');
    iframe.addEventListener('load', function () {
      if (!co || co.iframe !== iframe) return;
      co.loads++;
      if (co.loads === 2) { cEvent('checkout_next_step'); fb('trackCustom', 'CheckoutNextStep', tripData()); }
      if (co.loads === 3) { cEvent('checkout_step_3'); fb('trackCustom', 'CheckoutStep3', tripData()); }
    });
    log('checkout opened');
  }

  function onCheckoutClose() {
    if (!co || co.closedSent) return;
    co.closedSent = true;
    var secs = Math.round((Date.now() - co.t0) / 1000);
    cEvent('checkout_closed');
    cTag('checkout_time', bucket(secs));
    cTag('checkout_engaged', co.engaged ? 'yes' : 'no');
    fb('trackCustom', 'CheckoutClosed', tripData({ seconds_open: secs, engaged: co.engaged ? 1 : 0 }));
    log('checkout closed after', secs, 's engaged:', co.engaged);
    co = null;
  }

  function isWTFrame(n) { return n && n.tagName === 'IFRAME' && /wetravel/i.test(n.src || n.getAttribute('src') || ''); }
  function frameVisible(f) { if (!f.isConnected) return false; var r = f.getBoundingClientRect(); var st = getComputedStyle(f); return r.width > 50 && r.height > 50 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'; }

  /* Visitor tapped into the pop-up = window loses focus to the iframe */
  window.addEventListener('blur', function () {
    setTimeout(function () {
      var ae = document.activeElement;
      if (co && ae === co.iframe && !co.engaged) {
        co.engaged = true;
        cEvent('checkout_interacted');
        fb('trackCustom', 'CheckoutEngaged', tripData());
        tt('AddToCart', ttData(trip && trip.id, trip && trip.name, trip && trip.value));
        log('checkout engaged');
      }
    }, 0);
  });

  function scan() {
    var frames = document.querySelectorAll('iframe');
    var open = null;
    for (var i = 0; i < frames.length; i++) if (isWTFrame(frames[i]) && /checkout/i.test(frames[i].src) && frameVisible(frames[i])) open = frames[i];
    if (open) onCheckoutOpen(open); else if (co) onCheckoutClose();
  }
  if (window.MutationObserver) {
    new MutationObserver(function () { setTimeout(scan, 50); })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src'] });
  }
  setInterval(scan, 1500);
  window.addEventListener('pagehide', onCheckoutClose);

  /* Messages the WeTravel widget sends to our page.
     - "bookNowClicked"  -> Meta "Book Now Button Click" (same name as before,
       so your "Maldives - Book Now Click" custom conversion keeps working)
     - "bookingConfirmed" -> Meta Purchase with the real amount (this is what
       your Sales campaigns optimise for)
     - anything else is saved on the Clarity recording so we learn the steps */
  var purchaseSent = false, wtSeen = {};
  var PIXELS = ['1713039786496101', '1464656837954144'];
  function isWTOrigin(o) { return /(^|\.)wetravel\.com$/i.test(String(o || '').replace(/^https?:\/\//, '').replace(/:\d+$/, '')); }
  /* WeTravel has used a few message shapes over time: {type}, {event}, {action}, {name},
     sometimes nested in {data:{...}} or sent as a JSON string. Flatten them all. */
  function unwrap(d) {
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { d = { type: d.slice(0, 60) }; } }
    if (!d || typeof d !== 'object') return null;
    var inner = d.data || d.payload || d.detail;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch (x) { inner = null; } }
    var out = {}, k;
    if (inner && typeof inner === 'object') for (k in inner) out[k] = inner[k];
    for (k in d) if (k !== 'data' && k !== 'payload' && k !== 'detail') out[k] = d[k];
    out.type = String(d.type || d.event || d.action || d.name || d.eventName || (inner && (inner.type || inner.event || inner.name)) || 'unknown');
    return out;
  }
  function norm(t) { return String(t).toLowerCase().replace(/[^a-z]/g, ''); }
  function pickEmail(d) {
    var em = String(d.email || d.buyer_email || d.customer_email || (d.buyer && d.buyer.email) || (d.customer && d.customer.email) || '').trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) ? em : '';
  }
  function matchUser(em) {
    if (!em) return;
    try { if (window.ttq && window.ttq.identify) window.ttq.identify({ email: em }); } catch (x) {}
    PIXELS.forEach(function (id) { fb('init', id, { em: em }); });
    clarity('identify', em, null, null, em);
    try { if (GADS.id && window.gtag) window.gtag('set', 'user_data', { email: em }); } catch (x) {}
  }
  var stepSent = {};

  window.addEventListener('message', function (e) {
    if (DEBUG && e.data && !/clarity|tawk|tiktok/i.test(String(e.origin))) log('postMessage from', e.origin, e.data);
    if (!isWTOrigin(e.origin)) return;
    var d = unwrap(e.data);
    if (!d) return;
    var type = d.type, n = norm(type);
    log('wetravel message', type, d);
    /* Keep a short history of WeTravel message names (no personal details) so a test booking
       can be checked afterwards: in the console (top frame) run  JSON.parse(localStorage.tge_wt_log) */
    try { var hist = JSON.parse(ls('tge_wt_log') || '[]'); hist.push([new Date().toISOString(), type, Object.keys(d).join(',')]); ls('tge_wt_log', JSON.stringify(hist.slice(-40))); } catch (x) {}
    if (!wtSeen[type]) { wtSeen[type] = 1; cEvent('wt_' + type.replace(/[^\w]/g, '_').slice(0, 40)); }
    cTag('wt_last_message', type);
    var em = pickEmail(d);

    if (n === 'booknowclicked') {
      fb('trackCustom', 'Book Now Button Click', { source: d.source, content_name: d.trip_title || (trip && trip.name) });
      return;
    }
    if (n === 'inquirysent' || n === 'inquirysubmitted' || n === 'leadcreated') {
      matchUser(em);
      fb('track', 'Lead', { content_name: d.trip_name || d.trip_title || (trip && trip.name), content_category: 'WeTravel inquiry' });
      tt('SubmitForm', ttData(trip && trip.id, d.trip_title || (trip && trip.name), 0));
      gads(GADS.leadLabel);
      gev('generate_lead', { lead_source: 'WeTravel inquiry' });
      return;
    }
    var isPurchase = /^(booking|payment|order|checkout|purchase)(confirmed|completed|complete|success|succeeded|successful|paid)$/.test(n) || n === 'purchase' || n === 'bookingcreated';
    if (!isPurchase) {
      /* Checkout step messages (traveler info / add-ons / payment) - if WeTravel sends them */
      if (/payment/.test(n) && !stepSent.pay) {
        stepSent.pay = 1; matchUser(em);
        fb('track', 'AddPaymentInfo', tripData());
        tt('AddPaymentInfo', ttData(trip && trip.id, trip && trip.name, trip && trip.value));
        gev('add_payment_info', { value: trip ? trip.value : 0, currency: 'USD', items: gItems(trip && trip.id, trip && trip.name, trip && trip.value) });
      } else if (/(traveler|traveller|participant|addon|insurance|step)/.test(n) && !stepSent[n]) {
        stepSent[n] = 1; matchUser(em);
        fb('trackCustom', 'CheckoutStep', tripData({ step: type }));
      }
      return;
    }

    if (purchaseSent) return;
    purchaseSent = true;
    var tid = String(d.trip_uuid || d.trip_id || (trip && trip.id) || '');
    var rawAmt = [d.total_amount, d.amount, d.total, d.value].filter(function (x) { return x !== undefined && x !== null && x !== ''; })[0];
    var val = parseFloat(String(rawAmt === undefined ? '' : rawAmt).replace(/[^\d.]/g, '')) || 0;
    var cur = String(d.currency || 'USD').toUpperCase();
    /* Only fall back to the list price when WeTravel sends no amount at all.
       A real $0 (100%-off promo / test booking) stays $0 so it doesn't inflate revenue. */
    if (rawAmt === undefined && trip) { val = trip.value; cur = 'USD'; }
    var oid = d.order_id || d.booking_id || d.transaction_id || d.id || '';
    var key = 'tge_purchase_' + (oid || (tid + '_' + val));
    if (ss(key) || ls(key)) { log('purchase already sent'); return; }   // never count one booking twice (even after a refresh)
    ss(key, '1'); ls(key, String(Date.now()));
    var eid = 'wt_' + (oid || (tid + '_' + val + '_' + Math.floor(Date.now() / 60000)));
    var tname = d.trip_title || d.trip_name || (trip && trip.name);
    matchUser(em);
    cEvent('booking_completed');
    cTag('booked', 'yes');
    cTag('booking_value', val + ' ' + cur);
    clarity('upgrade', 'booking_completed');
    fb('track', 'Purchase', tripData({ content_ids: [tid], content_name: tname, value: val, currency: cur, num_items: Number(d.travelers || d.participants || d.quantity) || 1 }), { eventID: eid });
    tt('CompletePayment', Object.assign(ttData(tid, tname, val, cur), { event_id: eid }));
    gads(GADS.purchaseLabel, { value: val, currency: cur, transaction_id: eid });
    gev('purchase', { transaction_id: eid, value: val, currency: cur, items: gItems(tid, tname, val) });
    ls('tge_last_purchase', JSON.stringify({ at: new Date().toISOString(), trip: tname, value: val, currency: cur, id: eid, meta: !!window.fbq, google: !!window.gtag }));
    if (window.console) console.info('[TGE] Purchase sent to Meta + Google Ads + TikTok:', tname, val, cur, eid);
  });

  /* ---------- Forms: link the recording to the person ---------- */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.querySelector) return;
    var em = f.querySelector('input[type="email"], input[name="email"], input[name*="mail"]');
    if (!em || !/\S+@\S+\.\S+/.test(em.value || '')) return;
    var nm = f.querySelector('input[name="name"], input[name*="name"], input[name="first_name"]');
    var name = nm && nm.value ? nm.value.trim() : '';
    var email = em.value.trim().toLowerCase();
    var label = (name ? name + ' · ' : '') + email;
    clarity('identify', email, null, null, label);   // shows as the visitor's name in Clarity
    var ph = f.querySelector('input[type="tel"], input[name="contact"], input[name*="phone"], input[name*="whatsapp"]');
    var phone = ph && ph.value ? ph.value.replace(/[^\d+]/g, '') : '';
    try { if (window.ttq && window.ttq.identify) window.ttq.identify(phone && phone.charAt(0) === '+' ? { email: email, phone_number: phone } : { email: email }); } catch (x) {}
    PIXELS.forEach(function (id) { fb('init', id, phone && phone.charAt(0) === '+' ? { em: email, ph: phone.replace('+', '') } : { em: email }); });
    try { if (GADS.id && window.gtag) window.gtag('set', 'user_data', phone && phone.charAt(0) === '+' ? { email: email, phone_number: phone } : { email: email }); } catch (x) {}
    cTag('lead', 'yes');
    cTag('lead_form', f.getAttribute('action') ? f.getAttribute('action').split('/').pop() : (f.id || f.className || 'form'));
    cEvent('lead_form_submit');
    gads(GADS.leadLabel);
    gev('generate_lead', { lead_source: 'website form', trip: trip ? trip.name : 'none' });
    clarity('upgrade', 'lead');
    log('identified', label);
  }, true);

  log('ready', { trip: tripKey, pageType: pageType, inApp: inApp, src: src });
})();
