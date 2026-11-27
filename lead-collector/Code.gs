/**
 * TGE LEAD COLLECTOR  (Google Apps Script web app)
 * ------------------------------------------------------------------
 * Every website form (popups, VIP lists, register interest, contact,
 * Travel Identity quiz) posts here instead of Formspree.
 *
 * For each signup, in this order:
 *   1. Saves the full submission to the "Website Signups" tab   <- always first, so no lead is ever lost
 *   2. Adds / updates the person in the "Leads" tab (your CRM)
 *   3. Adds her to the matching Sender group(s), which starts that group's automation
 *      - if Sender fails, the row is marked "Pending" and retried every 10 minutes
 *      - after 3 failed tries you get an email alert
 *
 * Which Sender group each form goes to is set in the "Form Settings" tab,
 * so you can change it any time without touching code.
 *
 * Script properties (Project Settings > Script properties):
 *   SENDER_TOKEN  = your Sender API token   (required)
 *   ALERT_EMAIL   = where failure alerts go (optional, defaults to your Google account)
 */

var SPREADSHEET_ID = '1_hzy69IYPL62pYg7OZDbDkOGuUgTTG7V4UUkn2DNAqk'; // TGE Lead List
var SIGNUPS_TAB    = 'Website Signups';
var SETTINGS_TAB   = 'Form Settings';
var LEADS_TAB      = 'Leads';
var SENDER_API     = 'https://api.sender.net/v2';
var ALL_LEADS_GROUP = 'TGE Leads (all)';
var MAX_ATTEMPTS   = 12;   // ~2 hours of retries
var ALERT_AFTER    = 3;

var SIGNUP_HEADERS = ['Received', 'Submission ID', 'Form', 'Page', 'Name', 'Email', 'WhatsApp / phone',
  'Trip', 'Popup trigger', 'Message', 'All fields (JSON)', 'Sender groups', 'Sender status',
  'Attempts', 'Last error', 'CRM'];
// column numbers (1-based) in Website Signups
var C = { received: 1, sid: 2, form: 3, page: 4, name: 5, email: 6, phone: 7, trip: 8, trigger: 9, message: 10,
  json: 11, groups: 12, status: 13, attempts: 14, error: 15, crm: 16 };

/* Default routing, written to the "Form Settings" tab by setup(). Edit it in the sheet, not here. */
var DEFAULT_SETTINGS = [
  // form id,            Sender group (starts automation), also add to "TGE Leads (all)"?, start automation?, CRM trip interest,        CRM source,                                 CRM priority
  ['home-popup',        'Future trips',           'Yes', 'Yes', 'All trips (VIP list)',      'Website – Homepage VIP popup',              'Warm'],
  ['home-contact',      'Enquiries',              'Yes', 'Yes', 'General enquiry',           'Website – Homepage contact form',           '🔥 Hot'],
  ['bali-popup',        'Bali brochure',          'Yes', 'Yes', 'Island Life Bali',          'Website – Bali VIP popup',                  'Warm'],
  ['bali-interest',     'Bali brochure',          'Yes', 'Yes', 'Island Life Bali',          'Website – Bali register interest',          'Warm'],
  ['bali-contact',      'Enquiries',              'Yes', 'Yes', 'Island Life Bali',          'Website – Bali contact form',               '🔥 Hot'],
  ['komodo-popup',      'Komodo interest',        'Yes', 'Yes', 'Becoming HER Komodo',       'Website – Komodo waitlist popup',           'Warm'],
  ['komodo-interest',   'Komodo interest',        'Yes', 'Yes', 'Becoming HER Komodo',       'Website – Komodo register interest',        'Warm'],
  ['komodo-contact',    'Enquiries',              'Yes', 'Yes', 'Becoming HER Komodo',       'Website – Komodo contact form',             '🔥 Hot'],
  ['maldives-popup',    'Maldives VIP / interest', 'Yes', 'Yes', 'Maldives Girls Retreat',   'Website – Maldives VIP popup',              'Warm'],
  ['maldives-interest', 'Maldives VIP / interest', 'Yes', 'Yes', 'Maldives Girls Retreat',   'Website – Maldives register interest',      'Warm'],
  ['maldives-contact',  'Enquiries',              'Yes', 'Yes', 'Maldives Girls Retreat',    'Website – Maldives contact form',           '🔥 Hot'],
  ['quiz-lead',         'Travel Identity',        'Yes', 'Yes', '',                          'Website – Travel Identity',                 'Warm'],
  ['quiz-booked',       'Booked guests',          'No',  'No',  '',                          'Website – Travel Identity (booked guest)',  'Booked']
];
var SETTINGS_HEADERS = ['Form ID', 'Sender group', 'Also add to "TGE Leads (all)"', 'Start automation',
  'CRM trip interest', 'CRM source', 'CRM priority'];

/* =================================================================
   WEB APP ENTRY POINTS
   ================================================================= */

function doGet() {
  return json_({ ok: true, service: 'TGE lead collector' });
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  var ajax = p._ajax === '1';
  try {
    var result = capture_(p);
    if (ajax) return json_({ ok: true, duplicate: !!result.duplicate });
    return thanksPage_(p._next || p._page || 'https://thatgirlexperiences.com');
  } catch (err) {
    console.error(err);
    var isBadInput = /invalid email/i.test(String(err));   // visitor typo: she sees an error and can fix it, no alert needed
    if (!isBadInput) try { alert_('A website signup could not be saved', String(err) + '\n\nData received:\n' + JSON.stringify(p, null, 2)); } catch (x) {}
    if (ajax) return json_({ ok: false, error: String(err) });
    return thanksPage_(p._next || 'https://thatgirlexperiences.com');
  }
}

/* =================================================================
   CAPTURE
   ================================================================= */

function capture_(p) {
  var email = clean_(p.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Missing or invalid email: "' + email + '"');

  var formId = clean_(p.form_id) || 'unknown-form';
  var name = clean_(p.name) || [clean_(p.first_name), clean_(p.last_name)].join(' ').trim();
  var phone = clean_(p.contact) || clean_(p.whatsapp) || clean_(p.phone);
  var trip = clean_(p.trip) || clean_(p.trip_interested_in) || clean_(p.trip_joining);
  var message = clean_(p.message) || clean_(p.preferences);
  var sid = clean_(p._sid) || Utilities.getUuid();

  // everything except internal fields, for the JSON column
  var extra = {};
  Object.keys(p).forEach(function (k) { if (k.charAt(0) !== '_') extra[k] = p[k]; });

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var sheet, row;
  try {
    sheet = signupsSheet_();
    // duplicate protection (browser retries send the same submission ID)
    var dupRow = findRecentSid_(sheet, sid);
    if (dupRow) return { duplicate: true, row: dupRow };

    var setting = settingFor_(formId);
    var groups = groupsFor_(setting);
    sheet.appendRow([new Date(), sid, formId, clean_(p._page), name, email, "'" + phone, trip,
      clean_(p.source), message, JSON.stringify(extra), groups.join(', '),
      groups.length ? 'Pending' : 'No group set', 0, '', '']);
    row = sheet.getLastRow();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  // CRM row (never lets a CRM problem block the signup)
  try {
    var crm = upsertLead_({ name: name, email: email, phone: phone, trip: trip, formId: formId, message: message, extra: extra });
    sheet.getRange(row, C.crm).setValue(crm);
  } catch (err) {
    sheet.getRange(row, C.crm).setValue('CRM error: ' + err);
  }

  // Sender (if it fails, the retry trigger picks it up)
  syncRow_(sheet, row);
  return { duplicate: false, row: row };
}

/* =================================================================
   SENDER SYNC
   ================================================================= */

function syncRow_(sheet, row) {
  var v = sheet.getRange(row, 1, 1, SIGNUP_HEADERS.length).getValues()[0];
  var status = v[C.status - 1];
  if (status !== 'Pending') return;
  var attempts = Number(v[C.attempts - 1] || 0) + 1;
  var setting = settingFor_(v[C.form - 1]);
  try {
    var groups = groupsFor_(setting);
    var trigger = !setting || String(setting[3]).toLowerCase() !== 'no';
    pushToSender_(v[C.email - 1], v[C.name - 1], String(v[C.phone - 1] || ''), groups, trigger);
    sheet.getRange(row, C.status, 1, 3).setValues([['Synced ' + fmt_(new Date()), attempts, '']]);
  } catch (err) {
    var failed = attempts >= MAX_ATTEMPTS;
    sheet.getRange(row, C.status, 1, 3).setValues([[failed ? 'FAILED – add manually' : 'Pending', attempts, String(err).slice(0, 500)]]);
    if (attempts === ALERT_AFTER || failed) {
      alert_('Sender sync problem for ' + v[C.email - 1],
        'The lead IS saved in your TGE Lead List ("' + SIGNUPS_TAB + '" tab, row ' + row + ').\n' +
        'But she could not be added to Sender yet' + (failed ? ' and retries have stopped — please add her manually.' : ', it will keep retrying.') +
        '\n\nError: ' + err +
        '\n\nCommon fixes: check the SENDER_TOKEN script property, and that the group names in the "' + SETTINGS_TAB + '" tab match Sender exactly.');
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

  // 1) make sure the subscriber exists (no groups yet, so nothing fires here)
  var withPhone = phone && /^\+?[0-9][0-9\s\-()]{6,}$/.test(phone)
    ? Object.assign({}, base, { phone: phone.replace(/[\s\-()]/g, '') }) : null;
  var res = withPhone ? sender_('post', '/subscribers', withPhone) : null;
  if (!res || res.code >= 300) res = sender_('post', '/subscribers', base); // retry without phone (invalid phones are rejected)
  // a "subscriber already exists" error is fine — step 2 still adds her to the group

  // 2) add to each group (this is what starts the automation)
  ids.forEach(function (g) {
    var isAll = g.title === ALL_LEADS_GROUP;
    var r = sender_('post', '/subscribers/groups/' + g.id, {
      subscribers: [email],
      trigger_automation: isAll ? false : !!triggerAutomation
    });
    if (r.code >= 300) throw new Error('Sender ' + r.code + ' adding to "' + g.title + '": ' + r.text.slice(0, 300));
    var msg = (r.body && r.body.message) || {};
    var missing = (msg.non_existing_subscribers || []).map(function (x) { return String(x).toLowerCase(); });
    if (missing.indexOf(email) !== -1) throw new Error('Sender says subscriber does not exist (create failed): ' + res.text.slice(0, 300));
  });
}

function sender_(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('SENDER_TOKEN');
  if (!token) throw new Error('SENDER_TOKEN script property is not set');
  var resp = UrlFetchApp.fetch(SENDER_API + path, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true
  });
  var text = resp.getContentText();
  var body = null;
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

/* =================================================================
   RETRY (runs every 10 minutes via trigger created in setup)
   ================================================================= */

function retryPending() {
  var sheet = signupsSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return;
  var start = Math.max(2, last - 500);
  var statuses = sheet.getRange(start, C.status, last - start + 1, 1).getValues();
  for (var i = 0; i < statuses.length; i++) {
    if (statuses[i][0] === 'Pending') syncRow_(sheet, start + i);
  }
}

/* =================================================================
   CRM (Leads tab)
   ================================================================= */

function upsertLead_(d) {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LEADS_TAB);
  if (!sh) return 'No Leads tab';
  var setting = settingFor_(d.formId) || [];
  var tripInterest = setting[4] || d.trip || '';
  if (d.formId === 'quiz-lead' || d.formId === 'quiz-booked') tripInterest = d.trip || tripInterest;
  var source = setting[5] || ('Website – ' + d.formId);
  var priority = setting[6] || 'Warm';
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var note = noteFor_(d);

  var last = sh.getLastRow();
  var emails = last > 1 ? sh.getRange(2, 4, last - 1, 1).getValues() : [];
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).trim().toLowerCase() === d.email) {
      var r = i + 2;
      var cell = sh.getRange(r, 12);
      var prev = String(cell.getValue() || '');
      cell.setValue((prev ? prev + ' · ' : '') + fmt_(today) + ': signed up again via ' + source + (note ? ' (' + note + ')' : ''));
      if (!sh.getRange(r, 5).getValue() && d.phone) sh.getRange(r, 5).setValue("'" + d.phone);
      return 'Existing lead – row ' + r + ' updated';
    }
  }
  var isBooked = d.formId === 'quiz-booked';
  sh.appendRow([
    priority,
    isBooked ? 'Booked' : 'New – not contacted',
    d.name,
    d.email,
    d.phone ? "'" + d.phone : '',
    tripInterest,
    source,
    today,
    '', // Days since (formula below)
    '',
    isBooked ? 'Booked guest – Travel Identity done' : 'Auto email sequence started — personal follow-up in 2 days',
    note,
    d.phone ? 'WhatsApp' : 'Email'
  ]);
  var nr = sh.getLastRow();
  sh.getRange(nr, 9).setFormula('=TODAY()-H' + nr);
  sh.getRange(nr, 8).setNumberFormat(sh.getRange(2, 8).getNumberFormat());
  return 'New lead – row ' + nr;
}

function noteFor_(d) {
  var x = d.extra || {};
  var bits = [];
  if (x.identity_primary) bits.push(x.identity_primary + (x.identity_secondary ? ' / ' + x.identity_secondary : ''));
  if (x.booked) bits.push('booked: ' + x.booked);
  if (d.message) bits.push('Msg: ' + d.message.slice(0, 300));
  return bits.join('; ');
}

/* =================================================================
   SETUP & TESTS  (run these from the editor)
   ================================================================= */

/** Run once: creates the tabs + the 10-minute retry trigger, then checks your Sender token and groups. */
function setup() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  signupsSheet_();
  var st = ss.getSheetByName(SETTINGS_TAB);
  if (!st) {
    st = ss.insertSheet(SETTINGS_TAB);
    st.getRange(1, 1, 1, SETTINGS_HEADERS.length).setValues([SETTINGS_HEADERS]).setFontWeight('bold');
    st.getRange(2, 1, DEFAULT_SETTINGS.length, SETTINGS_HEADERS.length).setValues(DEFAULT_SETTINGS);
    st.setFrozenRows(1);
    st.autoResizeColumns(1, SETTINGS_HEADERS.length);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'retryPending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('retryPending').timeBased().everyMinutes(10).create();
  Logger.log(checkSender());
}

/** Checks the token works and every group in "Form Settings" exists in Sender. */
function checkSender() {
  CacheService.getScriptCache().remove('senderGroups');
  var problems = [];
  var titles = {};
  readSettings_().forEach(function (s) { titles[s[1]] = 1; if (String(s[2]).toLowerCase() !== 'no') titles[ALL_LEADS_GROUP] = 1; });
  Object.keys(titles).forEach(function (t) { if (t && !groupId_(t)) problems.push('Group not found in Sender: "' + t + '"'); });
  var msg = problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'All good ✓ Sender token works and all ' + Object.keys(titles).length + ' groups were found.';
  return msg;
}

/** Sends one test signup through the whole flow, using your own email. Delete the test rows afterwards. */
function testSignup() {
  var me = Session.getEffectiveUser().getEmail();
  capture_({ form_id: 'home-popup', name: 'TEST Lead Collector', email: me, contact: '', _page: 'test', _sid: 'test-' + Date.now() });
  Logger.log('Test sent for ' + me + ' — check the "' + SIGNUPS_TAB + '" tab, the Leads tab and Sender (Future trips group).');
}

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
  var st = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SETTINGS_TAB);
  if (!st || st.getLastRow() < 2) return DEFAULT_SETTINGS;
  return st.getRange(2, 1, st.getLastRow() - 1, SETTINGS_HEADERS.length).getValues()
    .filter(function (r) { return String(r[0]).trim(); });
}

function settingFor_(formId) {
  var all = readSettings_();
  for (var i = 0; i < all.length; i++) if (String(all[i][0]).trim() === formId) return all[i];
  return null;
}

function groupsFor_(setting) {
  if (!setting) return [ALL_LEADS_GROUP];   // unknown form: still lands in the master list
  var g = [];
  if (String(setting[1]).trim()) g.push(String(setting[1]).trim());
  if (String(setting[2]).toLowerCase() !== 'no') g.push(ALL_LEADS_GROUP);
  return g;
}

function findRecentSid_(sheet, sid) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var start = Math.max(2, last - 300);
  var ids = sheet.getRange(start, C.sid, last - start + 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i][0] === sid) return start + i;
  return 0;
}

function alert_(subject, body) {
  var to = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, '[TGE website leads] ' + subject, body);
}

function clean_(v) { return v == null ? '' : String(v).trim(); }
function norm_(t) { return String(t || '').trim().toLowerCase(); }
function fmt_(d) { return Utilities.formatDate(d, 'Australia/Sydney', 'd MMM yyyy HH:mm'); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function thanksPage_(back) {
  var safe = /^https:\/\/(www\.)?thatgirlexperiences\.com/.test(back) ? back : 'https://thatgirlexperiences.com';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Georgia,serif;text-align:center;padding:4rem 1.5rem;color:#2b2b2b">' +
    '<h2>Thank you! 🤍</h2><p>We\'ve received your details and will be in touch soon.</p>' +
    '<p><a href="' + safe + '" target="_top" style="color:#b8935a">← Back to That Girl Experiences</a></p></div>'
  ).setTitle('Thank you — That Girl Experiences');
}
