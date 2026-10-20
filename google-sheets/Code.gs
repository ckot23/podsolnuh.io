/**
 * ============================================================================
 *  Гостиница «Подсолнух» — приём заявок на бронь с сайта в Google Таблицу + Telegram
 * ============================================================================
 *  Что делает скрипт:
 *   1. Принимает заявку с сайта (POST: имя и телефон) и добавляет строку в Google Таблицу.
 *   2. Отправляет сообщение модератору в Telegram (с кнопками
 *      «Подтвердить» / «Отклонить», если подключён вебхук — см. setupTelegram).
 *   3. Подтверждает доставку заявки (GET ?action=verify&ref=...).
 *
 *  Порядок настройки (подробно — в docs/booking-google-sheets.md):
 *   1. Откройте таблицу → Расширения → Apps Script.
 *   2. Вставьте код целиком, задайте BOT_TOKEN и MODERATOR_CHAT_ID в свойствах скрипта.
 *   3. Запустите setup() и разрешите доступ (при обновлении сначала обновите развёртывание).
 *   4. Развернуть → Новое развёртывание → Веб-приложение →
 *      «Запуск от имени: я», «Доступ: все, у кого есть ссылка».
 *   5. Скопируйте URL /exec и вставьте на сайте в админ-панели в поле
 *      «Google-таблица броней», либо в data/site.json → cfg.bookingApi.
 * ============================================================================
 */

/* ============================== НАСТРОЙКИ ================================ */

/** Секреты задаются в Apps Script → Настройки проекта → Свойства скрипта.
 *  BOT_TOKEN — новый токен из @BotFather. Никогда не публикуйте его на сайте.
 *  Переменная оставлена для совместимости с прежней настройкой внутри Apps Script. */
var BOT_TOKEN = '';

/** Кому присылать заявки: chat_id модератора. Несколько получателей — через запятую. */
var MODERATOR_CHAT_ID = '7114829971';

/** ID Google-таблицы (из её адреса: docs.google.com/spreadsheets/d/<ID>/edit).
 *  Если скрипт создан ВНУТРИ таблицы (Расширения → Apps Script) — оставьте пустым. */
var SHEET_ID = '';

/** Имя листа для броней. Создастся автоматически, если его нет. */
var SHEET_NAME = 'Брони';

/** Секрет вебхука хранится в свойствах скрипта WEBHOOK_SECRET.
 *  Если он не задан, setupTelegram() создаст случайный секрет автоматически. */
var WEBHOOK_SECRET = '';

/** Часовой пояс для дат и времени в таблице и в сообщениях. */
var TIMEZONE = 'Europe/Moscow';

/** Ключ защиты от повторной отправки одной и той же заявки (в минутах). */
var DEDUPE_MINUTES = 15;

/* =========================== КОНЕЦ НАСТРОЕК ============================== */

/* Видимы только два поля гостя: Имя и Контакты. Для доставки и модерации — четыре скрытые колонки. */
var HEADERS = [
  'Имя',
  'Контакты',
  '№заявки',
  'Дата заявки',
  'Статус',
  'Ref'
];
var COL = {
  name: 0, contacts: 1, phone: 1,
  id: 2, created: 3, status: 4, ref: 5
};
var VISIBLE_COUNT = 2;
var SCHEMA_VERSION = 3;

var STATUS_NEW = 'Новая';
var STATUS_OK = 'Подтверждена';
var STATUS_NO = 'Отклонена';
var STATUS_IN = 'Заселена';
var STATUS_END = 'Завершена';
var STATUS_LIST = [STATUS_NEW, STATUS_OK, STATUS_NO, STATUS_IN, STATUS_END];

var PROP = PropertiesService.getScriptProperties();

/* ============================ НАСТРОЙКА ================================== */

/**
 * Запустите один раз после вставки кода: создаёт лист «Брони» с шапкой,
 * оформлением и выпадающим списком статусов, проверяет Telegram.
 */
function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = getSpreadsheet_();
    ss.setSpreadsheetTimeZone(TIMEZONE);
    var sheet = getSheet_(ss, true); // миграция разрешена только при ручной настройке
    applyLayout_(sheet);
    // В веб-приложении активная таблица может быть недоступна: сохраняем её реальный id.
    PROP.setProperty('SHEET_ID', ss.getId());
    PROP.setProperty('SHEET_NAME', sheet.getName());
    SpreadsheetApp.flush();

    var check = tgCheck_();
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
    Logger.log(
      'Таблица готова: ' + ss.getName() + ' / лист «' + sheet.getName() + '».\n' +
      'Telegram: ' + check + '\n' +
      'URL веб-приложения: ' + (url || 'ещё не развёрнуто (Развернуть → Новое развёртывание → Веб-приложение)')
    );
    return check;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Подключить кнопки «Подтвердить / Отклонить» в Telegram.
 * Требует, чтобы веб-приложение уже было развёрнуто (URL /exec).
 * Запускать один раз; при смене WEBHOOK_SECRET — снова.
 */
function setupTelegram() {
  var url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Сначала разверните веб-приложение (Развернуть → Новое развёртывание).');
  var secret = webhookSecret_();
  if (!secret) {
    secret = Utilities.getUuid();
    PROP.setProperty('WEBHOOK_SECRET', secret);
  }
  var res = tg_('setWebhook', {
    url: url + '?secret=' + encodeURIComponent(secret),
    allowed_updates: JSON.stringify(['callback_query', 'message'])
  });
  Logger.log('setWebhook: ' + JSON.stringify(res));
  return res;
}

/** Отключить кнопки/вебхук (если что-то пошло не так). */
function removeTelegramWebhook() {
  return tg_('deleteWebhook', {});
}

/** Проверка связи: есть ли доступ к таблице и жив ли токен бота. */
function testConnection() {
  var ss = getSpreadsheet_();
  var check = tgCheck_();
  var info = 'Таблица: ' + ss.getName() + ' (' + ss.getUrl() + ')\n'
    + 'Telegram: ' + check + '\n'
    + 'Строк с заявками: ' + Math.max(0, getSheet_(ss).getLastRow() - 1);
  Logger.log(info);
  return info;
}

/* ============================== HTTP: GET ================================ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || 'health');
  try {
    if (action === 'status') return json_({ ok: true, statuses: {}, updatedAt: nowIso_() });
    if (action === 'verify') return json_({ ok: true, found: findRef_(String(p.ref || '')), updatedAt: nowIso_() });
    if (action === 'ping' || action === 'health') {
      var ss = getSpreadsheet_();
      var bot = tgCheck_(); // живой запрос к Telegram: «бот @… на связи» или текст ошибки
      return json_({
        ok: true,
        service: 'podsolnuh-booking',
        schemaVersion: SCHEMA_VERSION,
        fields: HEADERS.slice(0, VISIBLE_COUNT),
        sheet: ss.getName(),
        sheetUrl: ss.getUrl(),
        rows: Math.max(0, getSheet_(ss).getLastRow() - 1),
        telegram: /на связи/.test(bot) && getChatIds_().length > 0,
        bot: bot,
        updatedAt: nowIso_()
      });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ============================== HTTP: POST =============================== */

function doPost(e) {
  var body = rawBody_(e);
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (err) { parsed = null; }

  // 1) Апдейты от Telegram (кнопки «Подтвердить/Отклонить», команды бота)
  if (parsed && (parsed.callback_query || parsed.message)) {
    try {
      var secret = webhookSecret_();
      handleTelegramUpdate_(parsed, !!secret && (e && e.parameter && e.parameter.secret) === secret);
    } catch (err) {
      console.error('telegram update: ' + err);
    }
    return json_({ ok: true });
  }

  // 2) Заявка с сайта (обычная форма или JSON)
  var data = parsed || paramsToObject_(e);
  try {
    return json_(handleBooking_(data));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Обработка заявки: проверка имени и телефона, дедупликация, запись в таблицу, уведомление. */
function handleBooking_(data) {
  data = data || {};
  // Не пишем без блокировки: иначе два одновременных запроса могут затереть строку.
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(25000);
    locked = true;
    if (String(data.website || '').trim()) return { ok: true, ignored: true };
    if (data.action && data.action !== 'book') return { ok: false, error: 'Неизвестное действие.' };

    var name = String(data.name || '').trim();
    var contacts = String(data.contacts || data.phone || '').trim();
    if (name.length < 2 || name.length > 100) return { ok: false, error: 'Укажите имя (от 2 до 100 символов).' };
    if (!/^[+\d\s().-]+$/.test(contacts) || digits_(contacts).length < 10 || digits_(contacts).length > 15 || contacts.length > 32) {
      return { ok: false, error: 'Укажите контакты.' };
    }
    var ref = String(data.ref || '').trim();
    if (ref && !/^[a-zA-Z0-9_-]{1,120}$/.test(ref)) return { ok: false, error: 'Неверный идентификатор заявки.' };
    if (ref) {
      var dup = findRef_(ref);
      if (dup) return { ok: true, id: dup, duplicate: true, message: 'Заявка №' + dup + ' уже принята.' };
    }

    var recent = findRecent_(contacts, name);
    if (recent) return { ok: true, id: recent, duplicate: true, message: 'Заявка №' + recent + ' уже принята.' };

    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss);
    var row = sheet.getLastRow() + 1;
    var num = nextBookingId_(sheet);
    var createdAt = new Date();
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
    var values = [];
    values[COL.name] = sheetText_(name);
    values[COL.contacts] = sheetText_(contacts);
    values[COL.id] = num;
    values[COL.created] = createdAt;
    values[COL.status] = STATUS_NEW;
    values[COL.ref] = ref;
    sheet.getRange(row, 1, 1, VISIBLE_COUNT).setNumberFormat('@');
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([values]);
    sheet.getRange(row, COL.id + 1).setHorizontalAlignment('center');
    sheet.getRange(row, COL.created + 1).setNumberFormat('dd.MM.yyyy HH:mm');
    sheet.getRange(row, COL.status + 1).setDataValidation(statusRule_());
    SpreadsheetApp.flush(); // сначала гарантируем запись, затем отправляем Telegram
    PROP.setProperty('LAST_BOOKING_ID', String(num));

    var notified = notifyModerator_({
      id: num,
      created: createdAt,
      name: name,
      contacts: contacts,
      sheetUrl: sheetUrl_(ss, sheet)
    });
    return { ok: true, id: num, message: 'Заявка №' + num + ' принята.', row: row, notified: notified };
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
    '🕒 <b>Дата заявки:</b> ' + Utilities.formatDate(b.created || new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm'),
    '👤 <b>Имя:</b> ' + esc_(b.name),
    '📞 <b>Контакты:</b> <code>' + esc_(b.contacts || b.phone) + '</code>',
    '',
    'Статус в таблице: <b>' + STATUS_NEW + '</b>'
  ];

  var keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Подтвердить', callback_data: 'ok:' + b.id },
        { text: '❌ Отклонить', callback_data: 'no:' + b.id }
      ],
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

/** Апдейты Telegram: нажатия кнопок и команды. */
function handleTelegramUpdate_(update, secretOk) {
  var allowed = getChatIds_().map(String);

  if (update.callback_query) {
    var cb = update.callback_query;
    if (!secretOk) return;
    var from = cb.from && String(cb.from.id);
    if (!allowed.length || allowed.indexOf(from) === -1) {
      tg_('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа', show_alert: true });
      return;
    }
    var parts = String(cb.data || '').split(':');
    if (parts.length !== 2) return;
    var id = parseInt(parts[1], 10);
    if (!id) return;
    var status = parts[0] === 'ok' ? STATUS_OK : (parts[0] === 'no' ? STATUS_NO : '');
    if (!status) return;

    var saved = setStatusById_(id, status);
    tg_('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: saved ? ('Заявка №' + id + ': ' + status) : ('Заявка №' + id + ' не найдена')
    });
    if (saved) {
      var original = cb.message && cb.message.text ? cb.message.text : '';
      var head = esc_(original.replace(/\nСтатус в таблице:[\s\S]*$/, '').trim());
      var mark = status === STATUS_OK
        ? '✅ <b>Подтверждено</b> модератором'
        : '❌ <b>Отклонено</b> модератором';
      tg_('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: head + '\n\n' + mark + '\n🕒 ' + Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm'),
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '📊 Открыть таблицу', url: getSpreadsheet_().getUrl() }]] })
      });
    }
    return;
  }

  if (update.message) {
    if (!secretOk) return;
    var chatId = String(update.message.chat && update.message.chat.id);
    var text = String(update.message.text || '').trim().toLowerCase();
    if (allowed.indexOf(chatId) !== -1) {
      if (/^\/(start|help)/.test(text)) {
        tg_('sendMessage', {
          chat_id: chatId,
          text: '🌻 Бот броней «Подсолнух»\n\nЗаявки с сайта (имя и контакты) приходят сюда. Кнопки «Подтвердить» / «Отклонить» меняют статус заявки в таблице.\n\n/today — заявки за сегодня',
          parse_mode: 'HTML'
        });
      } else if (/^\/(today|status)/.test(text)) {
        tg_('sendMessage', { chat_id: chatId, text: todayReport_(), parse_mode: 'HTML' });
      }
    }
  }
}

function todayReport_() {
  var sheet = getSheet_(getSpreadsheet_());
  var last = sheet.getLastRow();
  if (last < 2) return 'Пока нет ни одной заявки.';
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var stamp = Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy');
  var out = [];
  rows.forEach(function (r) {
    var created = r[COL.created] ? Utilities.formatDate(new Date(r[COL.created]), TIMEZONE, 'dd.MM.yyyy') : '';
    if (created !== stamp) return;
    out.push('• №' + r[COL.id] + ' — ' + esc_(r[COL.name]) + ', ' + esc_(r[COL.contacts]) + ', ' + esc_(String(r[COL.status]).toLowerCase()));
  });
  return out.length ? ('📋 Заявки за сегодня (' + stamp + '):\n' + out.join('\n')) : 'Сегодня новых заявок не было.';
}

/** Меняет статус в строке с номером заявки. Возвращает true при успехе. */
function setStatusById_(id, status) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sheet = getSheet_(getSpreadsheet_());
    var last = sheet.getLastRow();
    if (last < 2) return false;
    var ids = sheet.getRange(2, COL.id + 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (parseInt(ids[i][0], 10) === id) {
        sheet.getRange(i + 2, COL.status + 1).setValue(status);
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } finally {
    lock.releaseLock();
  }
}

/* ============================== ХЕЛПЕРЫ ================================== */

function getSpreadsheet_() {
  var id = SHEET_ID || PROP.getProperty('SHEET_ID') || '';
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Укажите SHEET_ID в настройках скрипта.');
}

function getSheet_(ss, allowMigration) {
  var name = PROP.getProperty('SHEET_NAME') || SHEET_NAME || 'Брони';
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    ensureColumns_(sheet);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    applyLayout_(sheet);
  } else {
    migrateLayout_(sheet, allowMigration);
  }
  return sheet;
}

function ensureColumns_(sheet) {
  var missing = HEADERS.length - sheet.getMaxColumns();
  if (missing > 0) sheet.insertColumnsAfter(sheet.getMaxRows() ? sheet.getMaxColumns() : sheet.getMaxColumns(), missing);
}

function statusRule_() {
  return SpreadsheetApp.newDataValidation().requireValueInList(STATUS_LIST, true).setAllowInvalid(false).build();
}

function applyLayout_(sheet) {
  ensureColumns_(sheet);
  if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(1, 1);
  var count = sheet.getMaxRows() - 1;
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold').setBackground('#f7a93c').setFontColor('#3a2a08')
    .setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(1, 40);
  [210, 190, 85, 150, 130, 110].forEach(function(w, i){ sheet.setColumnWidth(i + 1, w); });
  // Удаляем старые правила со всех колонок, чтобы они не мешали переносу.
  sheet.getRange(2, 1, count, sheet.getMaxColumns()).clearDataValidations();
  var rule = statusRule_();
  sheet.getRange(2, COL.status + 1, count, 1).setDataValidation(rule);
  sheet.getRange(2, 1, count, VISIBLE_COUNT).setNumberFormat('@').setVerticalAlignment('middle');
  sheet.getRange(2, COL.created + 1, count, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(2, COL.id + 1, count, HEADERS.length - VISIBLE_COUNT).setFontColor('#9a9a9a').setFontSize(9);
  sheet.showColumns(1, VISIBLE_COUNT);
  sheet.hideColumns(VISIBLE_COUNT + 1, sheet.getMaxColumns() - VISIBLE_COUNT);
}

/* Синонимы шапок старых версий; порядок соответствует HEADERS. */
var HEADER_ALIASES = [
  ['имя', 'фио', 'гость'],
  ['телефон', 'контакты', 'контакт', 'номер телефона'],
  ['№заявки', '№ заявки', '№', 'номер заявки', 'id'],
  ['дата заявки', 'дата заяки', 'дата'],
  ['статус'],
  ['ref']
];

function normHead_(s) {
  return String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function findAliasIdx_(oldNorm, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var k = oldNorm.indexOf(aliases[i]);
    if (k >= 0) return k;
  }
  return -1;
}

/** Перед перестройкой сохраняет весь старый лист со всеми прежними колонками. */
function backupLayout_(sheet) {
  var ss = sheet.getParent();
  var base = sheet.getName() + ' — архив ' + Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH-mm-ss');
  var name = base, suffix = 1;
  while (ss.getSheetByName(name)) name = base + ' (' + (++suffix) + ')';
  var backup = sheet.copyTo(ss).setName(name);
  backup.showColumns(1, backup.getMaxColumns());
  backup.setTabColor('#b7b7b7');
  Logger.log('Старый формат сохранён: «' + name + '».');
}

/** Переносит имя, телефон и служебные колонки по шапкам. Старые поля остаются в архиве. */
function migrateLayout_(sheet, allowMigration) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var lastRow = sheet.getLastRow();
  var oldHead = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h).trim(); });
  if (oldHead.join('|') === HEADERS.join('|')) return;
  if (!allowMigration) throw new Error('Обновите формат таблицы: запустите setup() в Apps Script.');
  var oldNorm = oldHead.map(normHead_);
  var idx = HEADER_ALIASES.map(function(aliases){ return findAliasIdx_(oldNorm, aliases); });
  var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var rows = data.map(function(r, rowIdx){
    var out = HEADERS.map(function(h, i){ return idx[i] >= 0 ? r[idx[i]] : ''; });
    if (!out[COL.id]) out[COL.id] = rowIdx + 1;
    out[COL.status] = normStatus_(out[COL.status]);
    out[COL.name] = sheetText_(out[COL.name]);
    return out;
  });
  backupLayout_(sheet); // если резервная копия не создалась, исходный лист не трогаем
  ensureColumns_(sheet);
  sheet.getRange(1, 1, Math.max(lastRow, 1), Math.max(lastCol, HEADERS.length)).clearContent().clearDataValidations();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, VISIBLE_COUNT).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }
  applyLayout_(sheet);
}

function nextBookingId_(sheet) {
  var last = sheet.getLastRow();
  var ids = last > 1 ? sheet.getRange(2, COL.id + 1, last - 1, 1).getValues() : [];
  return ids.reduce(function(max, r){ return Math.max(max, parseInt(r[0], 10) || 0); }, Number(PROP.getProperty('LAST_BOOKING_ID')) || 0) + 1;
}

function sheetUrl_(ss, sheet) {
  return ss.getUrl() + '#gid=' + sheet.getSheetId();
}

function findRef_(ref) {
  if (!ref) return 0;
  return findRow_(function (r) { return String(r[COL.ref] || '').trim() === ref; });
}

function findRecent_(contacts, name) {
  return findRow_(function(r){
    if (phoneDigits_(r[COL.contacts]) !== phoneDigits_(contacts)) return false;
    if (normStatus_(r[COL.status]) !== STATUS_NEW) return false;
    var created = r[COL.created] ? new Date(r[COL.created]).getTime() : 0;
    if (!created || (Date.now() - created) > DEDUPE_MINUTES * 60000) return false;
    return String(r[COL.name]).replace(/^'(?==)/, '').trim() === name;
  });
}

function findRow_(predicate) {
  var sheet = getSheet_(getSpreadsheet_());
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) return parseInt(rows[i][COL.id], 10) || (i + 1);
  }
  return 0;
}

function normStatus_(v) {
  var s = String(v || '').trim().toLowerCase();
  if (s.indexOf('подтв') === 0) return STATUS_OK;
  if (s.indexOf('откл') === 0 || s.indexOf('отмен') === 0) return STATUS_NO;
  if (s.indexOf('засел') === 0) return STATUS_IN;
  if (s.indexOf('заверш') === 0) return STATUS_END;
  return STATUS_NEW;
}
function digits_(v) { return String(v || '').replace(/\D/g, ''); }
function phoneDigits_(v) {
  var d = digits_(v);
  return d.length === 11 && d[0] === '8' ? '7' + d.slice(1) : d;
}
function sheetText_(v) {
  var s = String(v || '');
  // setValues трактует строку, начинающуюся с «=», как формулу. Пишем буквальный текст.
  return /^\s*=/.test(s) ? "'" + s : s;
}
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function nowIso_() { return new Date().toISOString(); }

function rawBody_(e) {
  if (e && e.postData && e.postData.contents) return e.postData.contents;
  return '';
}
function paramsToObject_(e) {
  var out = {};
  var p = (e && e.parameter) || {};
  Object.keys(p).forEach(function (k) { out[k] = p[k]; });
  return out;
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
function webhookSecret_() { return PROP.getProperty('WEBHOOK_SECRET') || WEBHOOK_SECRET; }

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
    if (result && result.description) result.description = String(result.description).split(token).join('[скрыто]');
    return result;
  } catch (err) {
    // Исключение UrlFetchApp может содержать URL с токеном. Не выдаём его через публичный ping.
    console.error('tg_ ' + method + ': ' + String(err).split(token).join('[скрыто]'));
    return { ok: false, description: 'Не удалось связаться с Telegram.' };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
