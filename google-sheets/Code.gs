/**
 * ============================================================================
 *  Гостиница «Подсолнух» — приём заявок на бронь в Google Таблицу
 * ============================================================================
 *  В таблице создаются только 2 колонки:
 *    1. Имя
 *    2. Номер телефона
 *
 *  Инструкция для новой таблицы:
 *   1. Создайте новую Google Таблицу.
 *   2. Откройте в ней: Расширения → Apps Script.
 *   3. Замените весь код в файле Code.gs этим кодом и нажмите «Сохранить» (Ctrl+S).
 *   4. Нажмите «Выполнить» (функция setup) и разрешите доступ.
 *   5. Нажмите «Развернуть» → «Новое развёртывание»:
 *      - Выберите тип: «Веб-приложение»
 *      - Запуск от имени: «Меня»
 *      - У кого есть доступ: «Все»
 *   6. Нажмите «Развернуть» и скопируйте ссылку веб-приложения (заканчивается на /exec).
 * ============================================================================
 */

/* ============================== НАСТРОЙКИ ================================ */

/** Имя листа для заявок. Если в новой таблице пустой «Лист1», он переименуется сам. */
var SHEET_NAME = 'Брони';

/** ID таблицы (оставьте пустым, если скрипт создан внутри таблицы через Расширения → Apps Script). */
var SHEET_ID = '';

/** Необязательно: токен Telegram-бота от @BotFather (или задайте BOT_TOKEN в Свойствах скрипта). */
var BOT_TOKEN = '';

/** Необязательно: chat_id получателя уведомлений в Telegram (несколько — через запятую). */
var MODERATOR_CHAT_ID = '7114829971';

/** Часовой пояс. */
var TIMEZONE = 'Europe/Moscow';

/** Защита от повторной отправки одной и той же заявки при двойном клике (в минутах). */
var DEDUPE_MINUTES = 15;

/* =========================== СТРУКТУРА ТАБЛИЦЫ =========================== */

var HEADERS = ['Имя', 'Номер телефона'];
var COL = { name: 0, phone: 1 };
var VISIBLE_COUNT = 2;
var SCHEMA_VERSION = 4;

var PROP = PropertiesService.getScriptProperties();

/* ============================ НАСТРОЙКА ================================== */

/**
 * Запустите один раз после вставки кода:
 * оформляет лист с двумя колонками («Имя» и «Номер телефона»).
 */
function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = getSpreadsheet_();
    ss.setSpreadsheetTimeZone(TIMEZONE);
    var sheet = getSheet_(ss);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    formatSheet_(sheet);
    PROP.setProperty('SHEET_ID', ss.getId());
    PROP.setProperty('SHEET_NAME', sheet.getName());
    SpreadsheetApp.flush();

    var check = tgCheck_();
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
    Logger.log(
      'Таблица готова: ' + ss.getName() + ' / лист «' + sheet.getName() + '»\n' +
      'Колонки: ' + HEADERS.join(' | ') + '\n' +
      'Telegram: ' + check + '\n' +
      'URL веб-приложения: ' + (url || 'нажмите «Развернуть» → «Новое развёртывание» → «Веб-приложение»')
    );
    return check;
  } finally {
    lock.releaseLock();
  }
}

/** Проверка связи с таблицей и Telegram. */
function testConnection() {
  var ss = getSpreadsheet_();
  var sheet = getSheet_(ss);
  var check = tgCheck_();
  var info = 'Таблица: ' + ss.getName() + ' (' + ss.getUrl() + ')\n' +
    'Лист: ' + sheet.getName() + '\n' +
    'Строк с заявками: ' + Math.max(0, sheet.getLastRow() - 1) + '\n' +
    'Telegram: ' + check;
  Logger.log(info);
  return info;
}

/* ============================== HTTP: GET ================================ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || 'health');
  try {
    if (action === 'verify') {
      return json_({ ok: true, found: verifyRef_(String(p.ref || '')), updatedAt: nowIso_() });
    }
    if (action === 'ping' || action === 'health') {
      var ss = getSpreadsheet_();
      var sheet = getSheet_(ss);
      var bot = tgCheck_();
      return json_({
        ok: true,
        service: 'podsolnuh-booking',
        schemaVersion: SCHEMA_VERSION,
        fields: HEADERS.slice(),
        sheet: ss.getName(),
        sheetUrl: ss.getUrl(),
        rows: Math.max(0, sheet.getLastRow() - 1),
        telegram: /на связи/.test(bot) && getChatIds_().length > 0,
        bot: bot,
        updatedAt: nowIso_()
      });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/* ============================== HTTP: POST =============================== */

function doPost(e) {
  try {
    var data = parseData_(e);
    return json_(handleBooking_(data));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Запись заявки (только имя и номер телефона) в таблицу. */
function handleBooking_(data) {
  data = data || {};
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(25000);
    locked = true;

    if (String(data.website || '').trim()) {
      return { ok: true, ignored: true };
    }
    if (data.action && data.action !== 'book') {
      return { ok: false, error: 'Неизвестное действие.' };
    }

    var name = String(data.name || '').trim();
    var phone = String(data.phone || data.contacts || '').trim();

    if (name.length < 2 || name.length > 100) {
      return { ok: false, error: 'Укажите имя (от 2 до 100 символов).' };
    }
    if (!isValidPhone_(phone)) {
      return { ok: false, error: 'Укажите номер телефона.' };
    }

    var ref = String(data.ref || '').trim();
    if (ref && !/^[a-zA-Z0-9_-]{1,120}$/.test(ref)) {
      return { ok: false, error: 'Неверный идентификатор заявки.' };
    }

    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss);

    var dupId = findDuplicate_(sheet, name, phone, ref);
    if (dupId) {
      return { ok: true, id: dupId, duplicate: true, message: 'Заявка №' + dupId + ' уже принята.' };
    }

    var row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
    }

    var values = [sheetText_(name), sheetText_(phone)];
    var range = sheet.getRange(row, 1, 1, HEADERS.length);
    range.setNumberFormat('@');
    range.setValues([values]);
    SpreadsheetApp.flush();

    var id = Math.max(1, row - 1);
    saveRecentBooking_(id, row, name, phone, ref);

    var notified = notifyModerator_({
      id: id,
      name: name,
      phone: phone,
      sheetUrl: ss.getUrl() + '#gid=' + sheet.getSheetId()
    });

    return {
      ok: true,
      id: id,
      row: row,
      name: name,
      phone: phone,
      notified: notified,
      message: 'Заявка №' + id + ' принята.'
    };
  } finally {
    if (locked) lock.releaseLock();
  }
}

/* ========================= УВЕДОМЛЕНИЕ В TELEGRAM ======================== */

function notifyModerator_(b) {
  var ids = getChatIds_();
  if (!ids.length || !botToken_()) return false;

  var lines = [
    '🌻 <b>Новая заявка №' + b.id + '</b>',
    '',
    '👤 <b>Имя:</b> ' + esc_(b.name),
    '📞 <b>Номер телефона:</b> <code>' + esc_(b.phone) + '</code>'
  ];

  var keyboard = {
    inline_keyboard: [
      [{ text: '📊 Открыть таблицу', url: b.sheetUrl }]
    ]
  };

  var ok = false;
  ids.forEach(function (chatId) {
    var res = tg_('sendMessage', {
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: JSON.stringify(keyboard)
    });
    if (res && res.ok) ok = true;
    else console.error('sendMessage ' + chatId + ': ' + JSON.stringify(res));
  });
  return ok;
}

/* ============================== ТАБЛИЦА ================================== */

function getSpreadsheet_() {
  var configuredId = String(SHEET_ID || '').trim();
  if (configuredId) return SpreadsheetApp.openById(configuredId);

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    try { PROP.setProperty('SHEET_ID', active.getId()); } catch (e) {}
    return active;
  }

  var savedId = PROP.getProperty('SHEET_ID') || '';
  if (savedId) return SpreadsheetApp.openById(savedId);

  throw new Error('Не найдена таблица. Создайте скрипт внутри Google Таблицы (Расширения → Apps Script) или укажите SHEET_ID.');
}

function getSheet_(ss) {
  var targetName = PROP.getProperty('SHEET_NAME') || SHEET_NAME || 'Брони';
  var sheet = ss.getSheetByName(targetName);
  if (!sheet) {
    var all = typeof ss.getSheets === 'function' ? ss.getSheets() : [];
    if (all.length === 1 && all[0].getLastRow() === 0) {
      sheet = all[0];
      sheet.setName(targetName);
    } else if (all.length === 1) {
      sheet = all[0];
    } else {
      sheet = ss.insertSheet(targetName);
    }
  }
  ensureColumns_(sheet);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    formatSheet_(sheet);
  }
  return sheet;
}

function ensureColumns_(sheet) {
  var missing = HEADERS.length - sheet.getMaxColumns();
  if (missing > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), missing);
  }
}

function formatSheet_(sheet) {
  ensureColumns_(sheet);
  if (sheet.getMaxRows() < 2) {
    sheet.insertRowsAfter(1, 1);
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#f7a93c')
    .setFontColor('#3a2a08')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 38);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 220);
  var count = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 1, count, HEADERS.length)
    .setNumberFormat('@')
    .setVerticalAlignment('middle');
}

/* ===================== ЗАЩИТА ОТ ДУБЛЕЙ И ПРОВЕРКА ======================= */

function loadRecentBookings_() {
  var raw = PROP.getProperty('RECENT_BOOKINGS') || '[]';
  var list = [];
  try { list = JSON.parse(raw); } catch (e) { list = []; }
  if (!Array.isArray(list)) return [];
  var cutoff = Date.now() - DEDUPE_MINUTES * 60000;
  return list.filter(function (item) {
    return item && item.ts && item.ts >= cutoff;
  });
}

function saveRecentBooking_(id, row, name, phone, ref) {
  var list = loadRecentBookings_();
  list.push({
    id: id,
    row: row,
    name: name,
    phone: phoneDigits_(phone),
    ref: ref || '',
    ts: Date.now()
  });
  if (list.length > 30) list = list.slice(list.length - 30);
  PROP.setProperty('RECENT_BOOKINGS', JSON.stringify(list));
}

function findDuplicate_(sheet, name, phone, ref) {
  var list = loadRecentBookings_();
  var normPhone = phoneDigits_(phone);
  for (var i = list.length - 1; i >= 0; i--) {
    var item = list[i];
    var sameRef = ref && item.ref === ref;
    var sameGuest = item.phone === normPhone && item.name === name;
    if ((sameRef || sameGuest) && rowMatchesGuest_(sheet, item.row || (item.id + 1), name, normPhone)) {
      return item.id;
    }
  }
  return 0;
}

function rowMatchesGuest_(sheet, rowIdx, name, normPhone) {
  if (rowIdx < 2 || rowIdx > sheet.getLastRow()) return false;
  var vals = sheet.getRange(rowIdx, 1, 1, HEADERS.length).getValues()[0];
  var rowName = String(vals[COL.name] || '').replace(/^'(?==)/, '').trim();
  var rowPhone = phoneDigits_(vals[COL.phone]);
  return rowName === name && rowPhone === normPhone;
}

function verifyRef_(ref) {
  if (!ref) return 0;
  var list = loadRecentBookings_();
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i].ref === ref) return list[i].id || 1;
  }
  return 0;
}

/* ============================== ХЕЛПЕРЫ ================================== */

function parseData_(e) {
  var out = {};
  var p = (e && e.parameter) || {};
  Object.keys(p).forEach(function (k) { out[k] = p[k]; });

  var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
  if (!raw) return out;

  var trimmed = raw.trim();
  if (trimmed.charAt(0) === '{') {
    try {
      var parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach(function (k) { out[k] = parsed[k]; });
        return out;
      }
    } catch (err) {}
  }

  if (raw.indexOf('Content-Disposition:') !== -1) {
    raw.split(/------?[a-zA-Z0-9_-]+/).forEach(function (part) {
      var m = /name="([^"]+)"[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n)?$/.exec(part);
      if (m) out[m[1]] = m[2];
    });
    return out;
  }

  if (raw.indexOf('=') !== -1 && raw.indexOf('\n') === -1) {
    raw.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq === -1) return;
      try {
        var k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
        var v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
        if (k && out[k] === undefined) out[k] = v;
      } catch (err) {}
    });
  }

  return out;
}

function isValidPhone_(v) {
  var d = digits_(v);
  return /^[+\d\s().-]+$/.test(v) && d.length >= 10 && d.length <= 15 && v.length <= 32;
}

function digits_(v) {
  return String(v || '').replace(/\D/g, '');
}

function phoneDigits_(v) {
  var d = digits_(v);
  return d.length === 11 && d.charAt(0) === '8' ? '7' + d.slice(1) : d;
}

function sheetText_(v) {
  var s = String(v || '');
  return /^\s*=/.test(s) ? "'" + s : s;
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nowIso_() {
  return new Date().toISOString();
}

function getChatIds_() {
  var configured = PROP.getProperty('MODERATOR_CHAT_ID');
  return String(configured === null ? MODERATOR_CHAT_ID : configured)
    .split(/[,\s;]+/)
    .map(function (s) { return s.trim(); })
    .filter(String);
}

function botToken_() {
  var token = PROP.getProperty('BOT_TOKEN') || BOT_TOKEN;
  return token && token.indexOf('ВСТАВЬТЕ') !== 0 ? token : '';
}

function tgCheck_() {
  if (!botToken_()) return 'токен бота не указан';
  var me = tg_('getMe', {});
  if (me && me.ok) return 'бот @' + me.result.username + ' на связи';
  return 'ошибка: ' + JSON.stringify(me);
}

function tg_(method, payload) {
  var token = botToken_();
  if (!token) return { ok: false, description: 'BOT_TOKEN не настроен' };
  try {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
    var result = JSON.parse(res.getContentText());
    if (result && result.description) {
      result.description = String(result.description).split(token).join('[скрыто]');
    }
    return result;
  } catch (err) {
    console.error('tg_ ' + method + ': ' + String(err).split(token).join('[скрыто]'));
    return { ok: false, description: 'Не удалось связаться с Telegram.' };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
