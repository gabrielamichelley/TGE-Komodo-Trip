/**
 * TGE LEAD COLLECTOR  v2  (Google Apps Script web app)
 * ------------------------------------------------------------------
 * Website forms (popups, VIP lists, register interest, contact forms,
 * Travel Identity quiz) + WeTravel notification emails all land here.
 *
 *  doPost (website)  -> saves the signup instantly and replies (fast for the visitor)
 *  scanWeTravel      -> every 5 min: reads WeTravel emails in Gmail (brochure downloads,
 *                       abandoned checkouts, new bookings) and saves them the same way
 *  processQueue      -> every 1 min: for each new signup
 *                         1. adds / updates the CRM (Leads tab; bookings also to Booked guests)
 *                         2. emails you a notification (contact forms: the full enquiry, Reply-To = her)
 *                         3. adds her to the Sender group(s) -> starts the automation
 *  retryPending      -> every 10 min: retries any Sender sync that failed; alerts you after 3 tries
 *  dailySummary      -> every evening ~9pm Sydney: summary of today's leads + contact history
 *
 * Routing per form is in the "Form Settings" tab of the sheet (edit there, not here).
 *
 * Script properties (Project Settings > Script properties):
 *   SENDER_TOKEN   (required)  your Sender API token
 *   NOTIFY_EMAIL   (optional)  where notifications/summaries go. Default: thatgirlexperiences@gmail.com
 *   ALERT_EMAIL    (optional)  where problem alerts go. Default: NOTIFY_EMAIL
 *   NOTIFY_EACH    (optional)  set to "No" to stop the per-lead notification emails
 */

var SPREADSHEET_ID = '1_hzy69IYPL62pYg7OZDbDkOGuUgTTG7V4UUkn2DNAqk'; // TGE Lead List
var SHEET_URL      = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/edit';
var SIGNUPS_TAB    = 'Website Signups';
var SETTINGS_TAB   = 'Form Settings';
var LEADS_TAB      = 'Leads';
var BOOKED_TAB     = 'Booked guests';
var SENDER_API     = 'https://api.sender.net/v2';
var ALL_LEADS_GROUP = 'TGE Leads (all)';
var DEFAULT_NOTIFY = 'thatgirlexperiences@gmail.com';
var TZ             = 'Australia/Sydney';
var MAX_ATTEMPTS   = 12;
var ALERT_AFTER    = 3;

var SIGNUP_HEADERS = ['Received', 'Submission ID', 'Form', 'Page', 'Name', 'Email', 'WhatsApp / phone',
  'Trip', 'Popup trigger', 'Message', 'All fields (JSON)', 'Sender groups', 'Sender status',
  'Attempts', 'Last error', 'CRM', 'Notified'];
var C = { received: 1, sid: 2, form: 3, page: 4, name: 5, email: 6, phone: 7, trip: 8, trigger: 9, message: 10,
  json: 11, groups: 12, status: 13, attempts: 14, error: 15, crm: 16, notified: 17 };

/* Default routing. setup() adds any of these that are missing from the "Form Settings" tab
   (it never overwrites your edits). */
var SETTINGS_HEADERS = ['Form ID', 'Sender group', 'Also add to "TGE Leads (all)"', 'Start automation',
  'CRM trip interest', 'CRM source', 'CRM priority'];
var DEFAULT_SETTINGS = [
  ['home-popup',        'Future trips',            'Yes', 'Yes', 'All trips (VIP list)',   'Website – Homepage VIP popup',            'Warm'],
  ['home-contact',      'Enquiries',               'Yes', 'Yes', 'General enquiry',        'Website – Homepage contact form',         '🔥 Hot'],
  ['bali-popup',        'Bali brochure',           'Yes', 'Yes', 'Island Life Bali',       'Website – Bali VIP popup',                'Warm'],
  ['bali-interest',     'Bali brochure',           'Yes', 'Yes', 'Island Life Bali',       'Website – Bali register interest',        'Warm'],
  ['bali-contact',      'Enquiries',               'Yes', 'Yes', 'Island Life Bali',       'Website – Bali contact form',             '🔥 Hot'],
  ['komodo-popup',      'Komodo interest',         'Yes', 'Yes', 'Becoming HER Komodo',    'Website – Komodo waitlist popup',         'Warm'],
  ['komodo-interest',   'Komodo interest',         'Yes', 'Yes', 'Becoming HER Komodo',    'Website – Komodo register interest',      'Warm'],
  ['komodo-contact',    'Enquiries',               'Yes', 'Yes', 'Becoming HER Komodo',    'Website – Komodo contact form',           '🔥 Hot'],
  ['maldives-popup',    'Maldives VIP / interest', 'Yes', 'Yes', 'Maldives Girls Retreat', 'Website – Maldives VIP popup',            'Warm'],
  ['maldives-interest', 'Maldives VIP / interest', 'Yes', 'Yes', 'Maldives Girls Retreat', 'Website – Maldives register interest',    'Warm'],
  ['maldives-contact',  'Enquiries',               'Yes', 'Yes', 'Maldives Girls Retreat', 'Website – Maldives contact form',         '🔥 Hot'],
  ['quiz-lead',         'Travel Identity',         'Yes', 'Yes', '',                       'Website – Travel Identity',               'Warm'],
  ['quiz-booked',       'Booked guests',           'No',  'No',  '',                       'Website – Travel Identity (booked guest)', 'Booked'],
  ['wetravel-brochure-maldives', 'Maldives brochure', 'Yes', 'Yes', 'Maldives Girls Retreat', 'WeTravel – brochure download',         'Warm'],
  ['wetravel-brochure-bali',     'Bali brochure',     'Yes', 'Yes', 'Island Life Bali',       'WeTravel – brochure download',         'Warm'],
  ['wetravel-brochure-komodo',   'Komodo interest',   'Yes', 'Yes', 'Becoming HER Komodo',    'WeTravel – brochure download',         'Warm'],
  ['wetravel-abandoned-maldives', 'Maldives brochure', 'Yes', 'Yes', 'Maldives Girls Retreat', 'WeTravel – abandoned checkout',       '🔥 Hot'],
  ['wetravel-abandoned-bali',     'Bali brochure',     'Yes', 'Yes', 'Island Life Bali',       'WeTravel – abandoned checkout',       '🔥 Hot'],
  ['wetravel-abandoned-komodo',   'Komodo interest',   'Yes', 'Yes', 'Becoming HER Komodo',    'WeTravel – abandoned checkout',       '🔥 Hot'],
  ['wetravel-booking-maldives',  'Booked guests',     'No',  'Yes', 'Maldives Girls Retreat', 'WeTravel – booking',                   'Booked'],
  ['wetravel-booking-bali',      'Booked guests',     'No',  'Yes', 'Island Life Bali',       'WeTravel – booking',                   'Booked'],
  ['wetravel-booking-komodo',    'Booked guests',     'No',  'Yes', 'Becoming HER Komodo',    'WeTravel – booking',                   'Booked']
];

/* =================================================================
   WEB APP  (kept as light as possible so the visitor isn't kept waiting)
   ================================================================= */

function doGet() { return json_({ ok: true, service: 'TGE lead collector v2' }); }

function doPost(e) {
  var p = (e && e.parameter) || {};
  var ajax = p._ajax === '1';
  try {
    var r = capture_(p);
    if (ajax) return json_({ ok: true, duplicate: !!r.duplicate });
    return thanksPage_(p._next || 'https://thatgirlexperiences.com');
  } catch (err) {
    var badInput = /invalid email/i.test(String(err));
    if (!badInput) { try { alert_('A website signup could not be saved', String(err) + '\n\nData received:\n' + JSON.stringify(p, null, 2)); } catch (x) {} }
    if (ajax) return json_({ ok: false, error: String(err) });
    return thanksPage_(p._next || 'https://thatgirlexperiences.com');
  }
}

/** Saves one signup row (status "Queued"). Everything else happens in processQueue. */
function capture_(p) {
  var email = clean_(p.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Missing or invalid email: "' + email + '"');
  var formId = clean_(p.form_id) || 'unknown-form';
  var name = clean_(p.name) || [clean_(p.first_name), clean_(p.last_name)].join(' ').trim();
  var phone = clean_(p.contact) || clean_(p.whatsapp) || clean_(p.phone);
  var trip = clean_(p.trip) || clean_(p.trip_interested_in) || clean_(p.trip_joining);
  var message = clean_(p.message) || clean_(p.preferences);
  var sid = clean_(p._sid) || Utilities.getUuid();
  var extra = {};
  Object.keys(p).forEach(function (k) { if (k.charAt(0) !== '_') extra[k] = p[k]; });

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sheet = signupsSheet_();
    var dup = findRecentSid_(sheet, sid, 300);
    if (dup) return { duplicate: true, row: dup };
    sheet.appendRow([new Date(), sid, formId, clean_(p._page), name, email, phone ? "'" + phone : '', trip,
      clean_(p.source), message, JSON.stringify(extra), '', 'Queued', 0, '', '', '']);
    return { duplicate: false, row: sheet.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

/* =================================================================
   BACKGROUND PROCESSING (every minute)
   ================================================================= */

function processQueue() {
  var cache = CacheService.getScriptCache();
  if (cache.get('processing')) return;          // a previous run is still going
  cache.put('processing', '1', 300);
  try {
    var sheet = signupsSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return;
    var start = Math.max(2, last - 300);
    var statuses = sheet.getRange(start, C.status, last - start + 1, 1).getValues();
    for (var i = 0; i < statuses.length; i++) {
      if (statuses[i][0] === 'Queued') processRow_(sheet, start + i);
    }
  } finally {
    cache.remove('processing');
  }
}

function processRow_(sheet, row) {
  var v = sheet.getRange(row, 1, 1, SIGNUP_HEADERS.length).getValues()[0];
  var d = rowData_(v);
  var setting = settingFor_(d.formId);
  var groups = groupsFor_(setting);
  sheet.getRange(row, C.groups).setValue(groups.join(', '));

  // 1) CRM
  try {
    sheet.getRange(row, C.crm).setValue(upsertLead_(d, setting));
    if (/^wetravel-booking|^quiz-booked/.test(d.formId)) upsertBooked_(d);
  } catch (err) { sheet.getRange(row, C.crm).setValue('CRM error: ' + err); }

  // 2) Email to you
  try {
    if (/-contact$/.test(d.formId)) { sendEnquiry_(d, setting); sheet.getRange(row, C.notified).setValue('Enquiry emailed ' + fmt_(new Date())); }
    else if (notifyEach_()) { sendNotification_(d, setting); sheet.getRange(row, C.notified).setValue('Notified ' + fmt_(new Date())); }
  } catch (err) { sheet.getRange(row, C.notified).setValue('Email error: ' + err); }

  // 3) Sender
  sheet.getRange(row, C.status).setValue(groups.length ? 'Pending' : 'No group set');
  if (groups.length) syncRow_(sheet, row);
}

function rowData_(v) {
  var extra = {};
  try { extra = JSON.parse(v[C.json - 1] || '{}'); } catch (e) {}
  return {
    received: v[C.received - 1], formId: String(v[C.form - 1]), page: String(v[C.page - 1] || ''),
    name: String(v[C.name - 1] || ''), email: String(v[C.email - 1] || '').toLowerCase(),
    phone: String(v[C.phone - 1] || ''), trip: String(v[C.trip - 1] || ''),
    trigger: String(v[C.trigger - 1] || ''), message: String(v[C.message - 1] || ''), extra: extra
  };
}

/* =================================================================
   EMAILS TO YOU
   ================================================================= */

function sendEnquiry_(d, setting) {
  var src = (setting && setting[5]) || d.formId;
  var html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">' +
    '<p><b>New enquiry</b> from the website (' + esc_(src) + ')</p>' +
    table_([['Name', d.name], ['Email', d.email], ['WhatsApp / phone', d.phone || '—'], ['Page', d.page]]) +
    '<p style="margin-top:16px"><b>Message:</b></p>' +
    '<div style="white-space:pre-wrap;border-left:3px solid #c9a96e;padding:8px 12px;background:#faf7f2">' + esc_(d.message) + '</div>' +
    '<p style="color:#777;font-size:12px;margin-top:16px">Just hit <b>Reply</b> — it goes straight to ' + esc_(d.email) + '. ' +
    'She has also been added to the CRM (<a href="' + SHEET_URL + '">TGE Lead List</a>).</p></div>';
  MailApp.sendEmail({
    to: notifyTo_(), replyTo: d.email, name: 'TGE Website',
    subject: '✉️ New enquiry: ' + (d.name || d.email) + ' — ' + shortSource_(src),
    htmlBody: html,
    body: 'New enquiry from ' + d.name + ' <' + d.email + '>\nPhone: ' + (d.phone || '-') + '\nPage: ' + d.page + '\n\n' + d.message
  });
}

function sendNotification_(d, setting) {
  var src = (setting && setting[5]) || d.formId;
  var icon = /booking/.test(d.formId) ? '🎉 New booking' : /abandoned/.test(d.formId) ? '⚠️ Abandoned checkout'
    : /brochure/.test(d.formId) ? '📄 Brochure download' : '🌴 New lead';
  var rows = [['Name', d.name || '—'], ['Email', d.email], ['WhatsApp / phone', d.phone || '—'],
    ['Source', src], ['Trip', d.trip || (setting && setting[4]) || '—'], ['Sender group', (setting && setting[1]) || '—']];
  if (d.trigger) rows.push(['Popup opened by', d.trigger]);
  if (d.extra.identity_primary) rows.push(['Travel Identity', d.extra.identity_primary]);
  if (d.extra.booked) rows.push(['Booked?', d.extra.booked]);
  if (d.extra.trip_date) rows.push(['Trip date', d.extra.trip_date]);
  if (d.page) rows.push(['Page', d.page]);
  MailApp.sendEmail({
    to: notifyTo_(), replyTo: d.email, name: 'TGE Website',
    subject: icon + ': ' + (d.name || d.email) + ' — ' + shortSource_(src),
    htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p><b>' + icon + '</b></p>' + table_(rows) +
      '<p style="color:#777;font-size:12px;margin-top:16px">Added to the <a href="' + SHEET_URL + '">TGE Lead List</a>' +
      ((setting && setting[1]) ? ' and the Sender group <b>' + esc_(setting[1]) + '</b>' : '') + '.</p></div>',
    body: icon + '\n' + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n')
  });
}

/** Evening summary of today's leads + how each has been contacted so far. */
function dailySummary() {
  var sheet = signupsSheet_();
  var last = sheet.getLastRow();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var rows = last > 1 ? sheet.getRange(2, 1, last - 1, SIGNUP_HEADERS.length).getValues() : [];
  var byEmail = {}, order = [];
  rows.forEach(function (v) {
    if (!(v[0] instanceof Date) || Utilities.formatDate(v[0], TZ, 'yyyy-MM-dd') !== today) return;
    var d = rowData_(v);
    if (!d.email) return;
    var s = settingFor_(d.formId);
    if (!byEmail[d.email]) { byEmail[d.email] = { d: d, sources: [] }; order.push(d.email); }
    var label = (s && s[5]) || d.formId;
    if (byEmail[d.email].sources.indexOf(label) === -1) byEmail[d.email].sources.push(label);
    if (!byEmail[d.email].d.name && d.name) byEmail[d.email].d.name = d.name;
  });

  var crm = crmIndex_();
  var counts = {};
  var body = order.map(function (email) {
    var x = byEmail[email], c = crm[email] || {};
    x.sources.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
    var g = gmailHistory_(email), s = senderHistory_(email);
    var contact = [];
    contact.push(g.count ? g.count + ' email' + (g.count > 1 ? 's' : '') + ' sent (last: ' + ago_(g.last) + ') — via Gmail' : 'No Gmail emails yet');
    contact.push(s.error ? 'Sender: couldn\'t check' : s.count ? s.count + ' email' + (s.count > 1 ? 's' : '') + ' sent (last: ' + ago_(s.last) + ')' +
      (s.opened ? ', ' + s.opened + ' opened' : '') + ' — via Sender' : 'No Sender emails yet');
    return '<tr>' + td_('<b>' + esc_(x.d.name || '—') + '</b><br>' + esc_(email) + (x.d.phone ? '<br>' + esc_(x.d.phone) : '')) +
      td_(esc_(x.sources.join(' · '))) + td_(esc_(c.trip || x.d.trip || '—')) +
      td_(esc_(c.status || '—') + (c.priority ? '<br><span style="color:#888">' + esc_(c.priority) + '</span>' : '')) +
      td_(contact.map(esc_).join('<br>')) + '</tr>';
  }).join('');

  var dateTxt = Utilities.formatDate(new Date(), TZ, 'EEEE d MMMM');
  var summary = Object.keys(counts).map(function (k) { return esc_(k) + ': <b>' + counts[k] + '</b>'; }).join('<br>');
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">' +
    '<h2 style="font-family:Georgia,serif;font-weight:normal">Today\'s Leads — ' + dateTxt + '</h2>' +
    (order.length
      ? '<p><b>' + order.length + ' new lead' + (order.length > 1 ? 's' : '') + '</b></p><p>' + summary + '</p>' +
        '<table cellpadding="8" style="border-collapse:collapse;font-size:13px;width:100%">' +
        '<tr style="background:#f3ede3;text-align:left"><th>Lead</th><th>Source / Point of Entry</th><th>Trip</th><th>Status</th><th>Contacted So Far</th></tr>' +
        body + '</table>'
      : '<p>No new leads today.</p>') +
    '<p style="color:#777;font-size:12px;margin-top:16px"><a href="' + SHEET_URL + '">Open the TGE Lead List</a></p></div>';
  MailApp.sendEmail({ to: notifyTo_(), name: 'TGE Website', subject: '📋 TGE daily leads — ' + dateTxt + ' (' + order.length + ')', htmlBody: html });
}

function gmailHistory_(email) {
  try {
    var me = Session.getEffectiveUser().getEmail().toLowerCase();
    var threads = GmailApp.search('in:sent to:' + email, 0, 30);
    var count = 0, lastD = null;
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        if (m.getFrom().toLowerCase().indexOf(me) !== -1 && (m.getTo() + ',' + m.getCc() + ',' + m.getBcc()).toLowerCase().indexOf(email) !== -1) {
          count++; if (!lastD || m.getDate() > lastD) lastD = m.getDate();
        }
      });
    });
    return { count: count, last: lastD };
  } catch (e) { return { count: 0, last: null }; }
}

function senderHistory_(email) {
  try {
    var r = sender_('get', '/subscribers/' + encodeURIComponent(email) + '/events?actions=' + encodeURIComponent('["got","opened"]'));
    if (r.code >= 300 || !r.body) return { error: true };
    var em = r.body.email || {};
    var got = em.got || [], opened = em.opened || [];
    var lastD = null;
    got.forEach(function (g) { var t = parseSenderDate_(g.created_at); if (t && (!lastD || t > lastD)) lastD = t; });
    return { count: got.length, opened: opened.length, last: lastD };
  } catch (e) { return { error: true }; }
}

/* =================================================================
   WETRAVEL (reads WeTravel's notification emails in this Gmail)
   ================================================================= */

function scanWeTravel() {
  var props = PropertiesService.getScriptProperties();
  var since = Number(props.getProperty('WT_SINCE') || 0);
  if (!since) { since = Date.now(); props.setProperty('WT_SINCE', String(since)); }  // never re-imports old emails
  var threads = GmailApp.search('from:(messages@wetravel.com OR noreply@wetravel.com) newer_than:3d', 0, 50);
  var sheet = signupsSheet_();
  var seen = recentSids_(sheet, 1500);
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (m.getDate().getTime() < since) return;
      var sid = 'wt-' + m.getId();
      if (seen[sid]) return;
      var lead = parseWeTravel_(m.getSubject(), m.getPlainBody());
      if (!lead) return;
      lead._sid = sid;
      lead._page = 'WeTravel email: ' + m.getSubject();
      try { capture_(lead); seen[sid] = 1; } catch (err) { console.warn('WeTravel parse skipped: ' + err + ' / ' + m.getSubject()); }
    });
  });
}

function parseWeTravel_(subject, body) {
  subject = String(subject || ''); body = String(body || '');
  if (/^\(Copy\)|Booking update|Payment received|NOTIFICATION/i.test(subject)) return null;
  var tripKey = /maldives/i.test(subject + body.slice(0, 600)) ? 'maldives'
    : /komodo|becoming her/i.test(subject + body.slice(0, 600)) ? 'komodo'
    : /bali|island life/i.test(subject + body.slice(0, 600)) ? 'bali' : null;
  if (!tripKey) return null;
  var tripName = (subject.split(/\s[–-]\s/).slice(1).join(' – ') || '').trim();
  var emails = (body.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [])
    .filter(function (e) { return !/wetravel\.com$|thatgirlexperiences/i.test(e); });
  var phoneM = body.match(/(?:^|\n)\s*(\+\d[\d\s\-]{7,}\d)\s*(?:\n|$)/);
  var phone = phoneM ? phoneM[1].trim() : '';

  if (/downloaded the brochure/i.test(subject + body)) {
    var em1 = (subject.match(/^(?:New opportunity:\s*)?([^\s]+@[^\s]+)\s/) || [])[1] || emails[0];
    if (!em1) return null;
    return { form_id: 'wetravel-brochure-' + tripKey, email: em1, name: '', contact: phone, trip: tripName };
  }
  if (/didn.?t complete checkout/i.test(subject)) {
    var nm = subject.replace(/\s+didn.?t complete checkout.*$/i, '').trim();
    var mailto = (body.match(/mailto:([^\s>]+)/) || [])[1] || emails[0];
    if (!mailto) return null;
    return { form_id: 'wetravel-abandoned-' + tripKey, email: mailto, name: titleCase_(nm), contact: phone, trip: tripName };
  }
  if (/^New Booking\b/i.test(subject)) {
    var bm = body.match(/confirmation email for:\s*\n\s*([^\n]+?)\s*\n\s*([^\s@]+@[^\s]+)/i);
    if (!bm) return null;
    var date = (body.match(/Trip\s*Date:\s*([A-Za-z]+\s+\d+\s*-\s*\d+,\s*\d{4})/) || [])[1] || '';
    var paid = (body.match(/Amount Paid:\*?\s*\n?\s*\*?(\$[\d,.]+)/) || [])[1] || '';
    return { form_id: 'wetravel-booking-' + tripKey, email: bm[2], name: bm[1], contact: phone, trip: tripName,
      trip_date: date, amount_paid: paid };
  }
  return null;
}

/* =================================================================
   SENDER
   ================================================================= */

function syncRow_(sheet, row) {
  var v = sheet.getRange(row, 1, 1, SIGNUP_HEADERS.length).getValues()[0];
  if (v[C.status - 1] !== 'Pending') return;
  var attempts = Number(v[C.attempts - 1] || 0) + 1;
  var setting = settingFor_(v[C.form - 1]);
  try {
    var groups = groupsFor_(setting);
    var trigger = !setting || String(setting[3]).toLowerCase() !== 'no';
    pushToSender_(String(v[C.email - 1]).toLowerCase(), v[C.name - 1], String(v[C.phone - 1] || ''), groups, trigger);
    sheet.getRange(row, C.status, 1, 3).setValues([['Synced ' + fmt_(new Date()), attempts, '']]);
  } catch (err) {
    var failed = attempts >= MAX_ATTEMPTS;
    sheet.getRange(row, C.status, 1, 3).setValues([[failed ? 'FAILED – add manually' : 'Pending', attempts, String(err).slice(0, 500)]]);
    if (attempts === ALERT_AFTER || failed) {
      alert_('Sender sync problem for ' + v[C.email - 1],
        'The lead IS saved in your TGE Lead List ("' + SIGNUPS_TAB + '" tab, row ' + row + ').\n' +
        'But she could not be added to Sender yet' + (failed ? ' and retries have stopped — please add her manually.' : ', it will keep retrying.') +
        '\n\nError: ' + err + '\n\nCommon fixes: check the SENDER_TOKEN script property, and that the group names in the "' +
        SETTINGS_TAB + '" tab match Sender exactly.');
    }
  }
}

function pushToSender_(email, name, phone, groupTitles, triggerAutomation) {
  if (!groupTitles.length) return;
  var ids = groupTitles.map(function (t) {
    var id = groupId_(t);
    if (!id) throw new Error('Sender group not found: "' + t + '"');
    return { title: t, id: id };
  });
  var parts = String(name || '').trim().split(/\s+/);
  var base = { email: email, firstname: parts.shift() || '', lastname: parts.join(' '), trigger_automation: false };
  var cleanPhone = String(phone || '').replace(/[\s\-()]/g, '');
  var res = /^\+\d{7,15}$/.test(cleanPhone) ? sender_('post', '/subscribers', Object.assign({}, base, { phone: cleanPhone })) : null;
  if (!res || res.code >= 300) res = sender_('post', '/subscribers', base);   // exists already / bad phone -> fine
  ids.forEach(function (g) {
    var r = sender_('post', '/subscribers/groups/' + g.id, {
      subscribers: [email], trigger_automation: g.title === ALL_LEADS_GROUP ? false : !!triggerAutomation
    });
    if (r.code >= 300) throw new Error('Sender ' + r.code + ' adding to "' + g.title + '": ' + r.text.slice(0, 300));
    var msg = (r.body && r.body.message) || {};
    var missing = (msg.non_existing_subscribers || []).map(function (x) { return String(x).toLowerCase(); });
    if (missing.indexOf(email) !== -1) throw new Error('Sender: subscriber could not be created: ' + res.text.slice(0, 300));
  });
}

function sender_(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('SENDER_TOKEN');
  if (!token) throw new Error('SENDER_TOKEN script property is not set');
  var resp = UrlFetchApp.fetch(SENDER_API + path, {
    method: method, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    payload: payload ? JSON.stringify(payload) : undefined, muteHttpExceptions: true
  });
  var text = resp.getContentText(), body = null;
  try { body = JSON.parse(text); } catch (e) {}
  return { code: resp.getResponseCode(), text: text, body: body };
}

function groupId_(title) {
  var cache = CacheService.getScriptCache();
  var map = cache.get('senderGroups');
  map = map ? JSON.parse(map) : null;
  if (!map || !map[norm_(title)]) {
    map = {};
    for (var page = 1; page <= 10; page++) {
      var r = sender_('get', '/groups?page=' + page);
      if (r.code >= 300) throw new Error('Sender ' + r.code + ' listing groups: ' + r.text.slice(0, 200));
      (r.body.data || []).forEach(function (g) { map[norm_(g.title)] = g.id; });
      if (!r.body.links || !r.body.links.next) break;
    }
    cache.put('senderGroups', JSON.stringify(map), 21600);
  }
  return map[norm_(title)] || null;
}

function retryPending() {
  var sheet = signupsSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return;
  var start = Math.max(2, last - 500);
  var statuses = sheet.getRange(start, C.status, last - start + 1, 1).getValues();
  for (var i = 0; i < statuses.length; i++) if (statuses[i][0] === 'Pending') syncRow_(sheet, start + i);
}

/* =================================================================
   CRM
   ================================================================= */

function upsertLead_(d, setting) {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LEADS_TAB);
  if (!sh) return 'No Leads tab';
  setting = setting || [];
  var isQuiz = /^quiz-/.test(d.formId);
  var tripInterest = isQuiz ? (d.trip || setting[4] || '') : (setting[4] || d.trip || '');
  var source = setting[5] || ('Website – ' + d.formId);
  var priority = setting[6] || 'Warm';
  var isBooked = /booking|quiz-booked/.test(d.formId);
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var note = noteFor_(d);

  var last = sh.getLastRow();
  var emails = last > 1 ? sh.getRange(2, 4, last - 1, 1).getValues() : [];
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).trim().toLowerCase() === d.email) {
      var r = i + 2;
      var cell = sh.getRange(r, 12), prev = String(cell.getValue() || '');
      cell.setValue((prev ? prev + ' · ' : '') + Utilities.formatDate(today, TZ, 'd MMM') + ': ' + source + (note ? ' (' + note + ')' : ''));
      if (!sh.getRange(r, 5).getValue() && d.phone) sh.getRange(r, 5).setValue("'" + d.phone);
      if (!sh.getRange(r, 3).getValue() && d.name) sh.getRange(r, 3).setValue(d.name);
      if (isBooked) { sh.getRange(r, 1, 1, 2).setValues([['Booked', 'Booked']]); sh.getRange(r, 11).setValue('Booked ' + (d.extra.trip_date || '') + ' — welcome + exclude from ads'); }
      else if (/abandoned/.test(d.formId)) sh.getRange(r, 1).setValue('🔥 Hot');
      return 'Existing lead – row ' + r + ' updated';
    }
  }
  sh.appendRow([
    priority, isBooked ? 'Booked' : 'New – not contacted', d.name, d.email, d.phone ? "'" + d.phone : '',
    tripInterest, source, today, '', '',
    isBooked ? 'Booked ' + (d.extra.trip_date || '') + ' — welcome + exclude from ads'
      : /abandoned/.test(d.formId) ? 'Abandoned checkout — message her today (WhatsApp/email)'
      : /-contact$/.test(d.formId) ? 'Reply to her enquiry (emailed to you)'
      : 'Auto email sequence started — personal follow-up in 2 days',
    note, d.phone ? 'WhatsApp' : 'Email'
  ]);
  var nr = sh.getLastRow();
  sh.getRange(nr, 9).setFormula('=TODAY()-H' + nr);
  sh.getRange(nr, 8).setNumberFormat('d mmm yyyy');
  return 'New lead – row ' + nr;
}

function upsertBooked_(d) {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(BOOKED_TAB);
  if (!sh) return;
  var last = sh.getLastRow();
  var emails = last > 1 ? sh.getRange(2, 2, last - 1, 1).getValues() : [];
  for (var i = 0; i < emails.length; i++) if (String(emails[i][0]).trim().toLowerCase() === d.email) return;
  if (!/^wetravel-booking/.test(d.formId)) return;     // quiz "booked" answers aren't proof of a booking
  sh.appendRow([d.name, d.email, d.phone ? "'" + d.phone : '', [d.trip, d.extra.trip_date].filter(String).join(' — '),
    Utilities.formatDate(new Date(), TZ, 'd MMM yyyy'), d.extra.amount_paid ? d.extra.amount_paid + ' paid' : '', 'Added automatically from WeTravel email']);
}

function crmIndex_() {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LEADS_TAB);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 13).getValues().forEach(function (r) {
    var e = String(r[3]).trim().toLowerCase();
    if (e) out[e] = { priority: r[0], status: r[1], trip: r[5], last: r[9] };
  });
  return out;
}

function noteFor_(d) {
  var x = d.extra || {}, bits = [];
  if (x.identity_primary) bits.push(x.identity_primary + (x.identity_secondary ? ' / ' + x.identity_secondary : ''));
  if (x.booked) bits.push('booked: ' + x.booked);
  if (x.trip_date) bits.push(x.trip_date);
  if (x.amount_paid) bits.push(x.amount_paid + ' paid');
  if (d.message) bits.push('Msg: ' + d.message.slice(0, 300));
  return bits.join('; ');
}

/* =================================================================
   SETUP & TESTS
   ================================================================= */

/** Run once after pasting (and again after any update). Safe to re-run. */
function setup() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.setSpreadsheetTimeZone(TZ);
  var sh = signupsSheet_();
  if (sh.getRange(1, C.notified).getValue() !== 'Notified') sh.getRange(1, C.notified).setValue('Notified').setFontWeight('bold');
  var st = ss.getSheetByName(SETTINGS_TAB);
  if (!st) {
    st = ss.insertSheet(SETTINGS_TAB);
    st.getRange(1, 1, 1, SETTINGS_HEADERS.length).setValues([SETTINGS_HEADERS]).setFontWeight('bold');
    st.setFrozenRows(1);
  }
  var have = {};
  if (st.getLastRow() > 1) st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = 1; });
  var missing = DEFAULT_SETTINGS.filter(function (r) { return !have[r[0]]; });
  if (missing.length) st.getRange(st.getLastRow() + 1, 1, missing.length, SETTINGS_HEADERS.length).setValues(missing);

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('retryPending').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('scanWeTravel').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailySummary').timeBased().atHour(21).everyDays(1).inTimezone(TZ).create();
  if (!PropertiesService.getScriptProperties().getProperty('WT_SINCE')) {
    PropertiesService.getScriptProperties().setProperty('WT_SINCE', String(Date.now()));
  }
  Logger.log(checkSender());
  Logger.log('Notifications go to: ' + notifyTo_());
}

function checkSender() {
  CacheService.getScriptCache().remove('senderGroups');
  var problems = [], titles = {};
  readSettings_().forEach(function (s) { titles[s[1]] = 1; if (String(s[2]).toLowerCase() !== 'no') titles[ALL_LEADS_GROUP] = 1; });
  Object.keys(titles).forEach(function (t) { if (t && !groupId_(t)) problems.push('Group not found in Sender: "' + t + '"'); });
  return problems.length ? 'PROBLEMS:\n' + problems.join('\n')
    : 'All good ✓ Sender token works and all ' + Object.keys(titles).length + ' groups were found.';
}

/** Optional: import WeTravel emails from the last N days (careful: starts Sender sequences for them). */
function backfillWeTravel(days) {
  PropertiesService.getScriptProperties().setProperty('WT_SINCE', String(Date.now() - (days || 2) * 86400000));
  scanWeTravel();
}

/** Sends yourself today's summary right now. */
function testDailySummary() { dailySummary(); }

/* =================================================================
   HELPERS
   ================================================================= */

function signupsSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(SIGNUPS_TAB);
  if (!sh) {
    sh = ss.insertSheet(SIGNUPS_TAB);
    sh.getRange(1, 1, 1, SIGNUP_HEADERS.length).setValues([SIGNUP_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readSettings_() {
  var cache = CacheService.getScriptCache();
  var c = cache.get('formSettings');
  if (c) return JSON.parse(c);
  var st = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SETTINGS_TAB);
  var rows = (!st || st.getLastRow() < 2) ? DEFAULT_SETTINGS
    : st.getRange(2, 1, st.getLastRow() - 1, SETTINGS_HEADERS.length).getValues().filter(function (r) { return String(r[0]).trim(); });
  cache.put('formSettings', JSON.stringify(rows), 120);
  return rows;
}

function settingFor_(formId) {
  var all = readSettings_();
  for (var i = 0; i < all.length; i++) if (String(all[i][0]).trim() === formId) return all[i];
  return null;
}

function groupsFor_(setting) {
  if (!setting) return [ALL_LEADS_GROUP];
  var g = [];
  if (String(setting[1]).trim()) g.push(String(setting[1]).trim());
  if (String(setting[2]).toLowerCase() !== 'no') g.push(ALL_LEADS_GROUP);
  return g;
}

function findRecentSid_(sheet, sid, n) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var start = Math.max(2, last - n);
  var ids = sheet.getRange(start, C.sid, last - start + 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === sid) return start + i;
  return 0;
}

function recentSids_(sheet, n) {
  var out = {}, last = sheet.getLastRow();
  if (last < 2) return out;
  var start = Math.max(2, last - n);
  sheet.getRange(start, C.sid, last - start + 1, 1).getValues().forEach(function (r) { out[r[0]] = 1; });
  return out;
}

function notifyTo_() { return PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || DEFAULT_NOTIFY; }
function notifyEach_() { return String(PropertiesService.getScriptProperties().getProperty('NOTIFY_EACH') || 'Yes').toLowerCase() !== 'no'; }

function alert_(subject, body) {
  var to = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL') || notifyTo_();
  MailApp.sendEmail(to, '[TGE website leads] ' + subject, body);
}

function shortSource_(s) { return String(s).replace(/^Website – /, '').replace(/^WeTravel – /, 'WeTravel '); }
function table_(rows) {
  return '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">' + rows.map(function (r) {
    return '<tr><td style="color:#888;padding-right:16px;vertical-align:top">' + esc_(r[0]) + '</td><td>' + esc_(r[1]) + '</td></tr>';
  }).join('') + '</table>';
}
function td_(h) { return '<td style="border-top:1px solid #eee;vertical-align:top">' + h + '</td>'; }
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function ago_(d) {
  if (!d) return '—';
  var days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago';
}
function parseSenderDate_(s) { if (!s) return null; var d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? null : d; }
function titleCase_(s) { return String(s).replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
function clean_(v) { return v == null ? '' : String(v).trim(); }
function norm_(t) { return String(t || '').trim().toLowerCase(); }
function fmt_(d) { return Utilities.formatDate(d, TZ, 'd MMM yyyy HH:mm'); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function thanksPage_(back) {
  var safe = /^https:\/\/(www\.)?thatgirlexperiences\.com/.test(back) ? back : 'https://thatgirlexperiences.com';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Georgia,serif;text-align:center;padding:4rem 1.5rem;color:#2b2b2b">' +
    '<h2>Thank you! 🤍</h2><p>We\'ve received your details and will be in touch soon.</p>' +
    '<p><a href="' + safe + '" target="_top" style="color:#b8935a">← Back to That Girl Experiences</a></p></div>'
  ).setTitle('Thank you — That Girl Experiences');
}
