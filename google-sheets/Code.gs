/**
 * ============================================================================
 *  Гостиница «Подсолнух» — приём броней с сайта в Google Таблицу + Telegram
 * ============================================================================
 *  Что делает скрипт:
 *   1. Принимает заявку с сайта (POST) и добавляет строку в Google Таблицу.
 *   2. Отправляет сообщение модератору в Telegram (с кнопками
 *      «Подтвердить» / «Отклонить», если подключён вебхук — см. setupTelegram).
 *   3. Отдаёт сайту статусы номеров (GET ?action=status): номер «занят»,
 *      если по нему есть подтверждённая бронь на сегодня.
 *   4. Подтверждает доставку заявки (GET ?action=verify&ref=...).
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

/* Только пять полей гостя видимы. Для доставки и модерации — пять скрытых колонок. */
var HEADERS = [
  'Имя',
  'Телефон',
  'Заезд/выезд',
  'Номер комнаты',
  'Отчётные документы',
  '№заявки',
  'Дата заявки',
  'Статус',
  'Ref',
  'RoomId'
];
var COL = {
  name: 0, phone: 1, dates: 2, room: 3, docs: 4,
  id: 5, created: 6, status: 7, ref: 8, roomId: 9
};
var VISIBLE_COUNT = 5;

/* Не доверяем названию номера из браузера: оно определяется на сервере по id. */
var ROOM_LABELS = {
  'single-1': 'Номер 1',
  'studio-4': 'Номер 2',
  'studio-comfort': 'Номер 3',
  'family-4': 'Номер 4',
  'apart-2': 'Номер 5',
  'double-2': 'Номер 6',
  'kitchen-3': 'Номер 7'
};

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
 * красивым оформлением и выпадающим списком статусов, проверяет Telegram.
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
    if (action === 'status') return json_({ ok: true, statuses: computeStatuses_(), updatedAt: nowIso_() });
    if (action === 'verify') return json_({ ok: true, found: findRef_(String(p.ref || '')), updatedAt: nowIso_() });
    if (action === 'ping' || action === 'health') {
      var ss = getSpreadsheet_();
      var bot = tgCheck_(); // живой запрос к Telegram: «бот @… на связи» или текст ошибки
      return json_({
        ok: true,
        service: 'podsolnuh-booking',
        schemaVersion: 2,
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

/** Обработка заявки: проверка, дедупликация, запись в таблицу, уведомление. */
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
    var phone = String(data.phone || data.contacts || '').trim();
    if (name.length < 2 || name.length > 100) return { ok: false, error: 'Укажите имя (от 2 до 100 символов).' };
    if (!/^[+\d\s().-]+$/.test(phone) || digits_(phone).length < 10 || digits_(phone).length > 15 || phone.length > 32) {
      return { ok: false, error: 'Укажите телефон.' };
    }
    var ref = String(data.ref || '').trim();
    if (ref && !/^[a-zA-Z0-9_-]{1,120}$/.test(ref)) return { ok: false, error: 'Неверный идентификатор заявки.' };
    if (ref) {
      var dup = findRef_(ref);
      if (dup) return { ok: true, id: dup, duplicate: true, message: 'Заявка №' + dup + ' уже принята.' };
    }

    if ((data.dateFrom && !parseIso_(data.dateFrom)) || (data.dateTo && !parseIso_(data.dateTo))) {
      return { ok: false, error: 'Проверьте даты заезда и выезда.' };
    }
    var range = parseDates_(data);
    if (!range.from || !range.to || range.nights < 1) {
      return { ok: false, error: 'Выберите даты заезда и выезда.' };
    }
    var roomId = roomId_(data.roomId || data.room || data.roomLabel || data.roomNumber);
    if (!roomId) return { ok: false, error: 'Выберите номер.' };
    var roomLabel = ROOM_LABELS[roomId];
    var docs = docsValue_(data.docs);

    // Сравниваем все поля: изменение выезда или галочки документов не потеряется как «дубль».
    var recent = findRecent_(phone, range.fromIso, range.toIso, roomId, docs, name);
    if (recent) return { ok: true, id: recent, duplicate: true, message: 'Заявка №' + recent + ' уже принята.' };

    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss);
    var row = sheet.getLastRow() + 1;
    var num = nextBookingId_(sheet);
    var createdAt = new Date();
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
    var values = [];
    values[COL.name] = sheetText_(name);
    values[COL.phone] = phone;
    values[COL.dates] = range.pair;
    values[COL.room] = roomLabel;
    values[COL.docs] = docs;
    values[COL.id] = num;
    values[COL.created] = createdAt;
    values[COL.status] = STATUS_NEW;
    values[COL.ref] = ref;
    values[COL.roomId] = roomId;
    sheet.getRange(row, 1, 1, VISIBLE_COUNT).setNumberFormat('@');
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([values]);
    sheet.getRange(row, COL.id + 1).setHorizontalAlignment('center');
    sheet.getRange(row, COL.created + 1).setNumberFormat('dd.MM.yyyy HH:mm');
    sheet.getRange(row, COL.status + 1).setDataValidation(statusRule_());
    SpreadsheetApp.flush(); // сначала гарантируем запись, затем отправляем Telegram
    PROP.setProperty('LAST_BOOKING_ID', String(num));

    var notified = notifyModerator_({
      id: num, created: createdAt, name: name, phone: phone,
      datesHuman: range.pair, from: range.fromIso, to: range.toIso,
      nights: range.nights, docs: docs, room: roomLabel,
      sheetUrl: sheetUrl_(ss, sheet)
    });
    return { ok: true, id: num, message: 'Заявка №' + num + ' принята.', row: row, notified: notified, nights: range.nights };
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
    '📞 <b>Телефон:</b> <code>' + esc_(b.phone) + '</code>',
    '📅 <b>Заезд/выезд:</b> ' + esc_(datesLine_(b)),
    '🛏 <b>Номер комнаты:</b> ' + esc_(b.room),
    '📄 <b>Отчётные документы:</b> ' + (b.docs === 'Да' ? 'Да (нужны)' : 'Нет')
  ].filter(String);

  lines.push('', 'Статус в таблице: <b>' + STATUS_NEW + '</b>');

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
          text: '🌻 Бот броней «Подсолнух»\n\nЗаявки с сайта приходят сюда. Кнопки «Подтвердить»/«Отклонить» меняют статус в таблице.\n\n/status — какие номера заняты сегодня\n/today — заявки на сегодня',
          parse_mode: 'HTML'
        });
      } else if (/^\/status/.test(text)) {
        var st = computeStatuses_();
        var busy = Object.keys(st).filter(function (k) { return st[k] === 'busy'; });
        tg_('sendMessage', {
          chat_id: chatId,
          text: busy.length ? ('🚫 Заняты сегодня: ' + busy.map(function(id){ return ROOM_LABELS[id] || id; }).join(', ')) : '🌻 Сегодня все номера свободны.',
          parse_mode: 'HTML'
        });
      } else if (/^\/today/.test(text)) {
        tg_('sendMessage', { chat_id: chatId, text: todayReport_(), parse_mode: 'HTML' });
      }
    }
  }
}

/** Даты для сообщения: без дублирования «(N сут.)», если строка уже с ним пришла. */
function datesLine_(b) {
  var human = String(b.datesHuman || '').trim();
  if (human) {
    if (!/\d+\s*сут/.test(human) && b.nights) human += ' — ' + b.nights + ' сут.';
    return human;
  }
  if (b.from && b.to) {
    var f = Utilities.formatDate(new Date(b.from), TIMEZONE, 'dd.MM.yyyy');
    var t = Utilities.formatDate(new Date(b.to), TIMEZONE, 'dd.MM.yyyy');
    return f + ' – ' + t + (b.nights ? ' (' + b.nights + ' сут.)' : '');
  }
  return 'не указаны';
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
    out.push('• №' + r[COL.id] + ' — ' + esc_(r[COL.name]) + ', ' + esc_(r[COL.phone]) + ', ' + esc_(r[COL.room]) + ', ' + esc_(String(r[COL.status]).toLowerCase()));
  });
  return out.length ? ('📋 Заявки за сегодня (' + stamp + '):\n' + out.join('\n')) : 'Сегодня новых заявок не было.';
}

/* ============================ СТАТУСЫ ДЛЯ САЙТА =========================== */

/**
 * Возвращает { 'single-1': 'busy', ... } — номера, занятые сегодня
 * по подтверждённым/заселённым броням.
 */
function computeStatuses_() {
  var out = {};
  try {
    var sheet = getSheet_(getSpreadsheet_());
    var last = sheet.getLastRow();
    if (last < 2) return out;
    var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
    var todayIso = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
    rows.forEach(function (r) {
      var status = normStatus_(r[COL.status]);
      var roomId = String(r[COL.roomId] || '').trim();
      if (!roomId) return;
      if (status !== STATUS_OK && status !== STATUS_IN) return;
      var range = parseDates_({ dates: r[COL.dates] });
      var from = range.from || toDate_(r[COL.dates]);
      if (!from) return;
      var to = range.to || new Date(from.getTime() + 86400000);
      var fromIso = range.fromIso || Utilities.formatDate(from, TIMEZONE, 'yyyy-MM-dd');
      var toIso = range.toIso || Utilities.formatDate(to, TIMEZONE, 'yyyy-MM-dd');
      if (todayIso >= fromIso && todayIso < toIso) out[roomId] = 'busy';
    });
  } catch (err) {
    console.error('computeStatuses_: ' + err);
  }
  return out;
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
  if (missing > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missing);
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
  [160, 160, 230, 130, 190, 85, 150, 130, 100, 100].forEach(function(w, i){ sheet.setColumnWidth(i + 1, w); });
  // Удаляем старые правила: бывшая колонка «Статус» теперь может содержать Ref.
  sheet.getRange(2, 1, count, sheet.getMaxColumns()).clearDataValidations();
  var rule = statusRule_();
  sheet.getRange(2, COL.status + 1, count, 1).setDataValidation(rule);
  sheet.getRange(2, 1, count, VISIBLE_COUNT).setNumberFormat('@').setVerticalAlignment('middle');
  sheet.getRange(2, COL.dates + 1, count, 1).setWrap(true);
  sheet.getRange(2, COL.created + 1, count, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(2, COL.id + 1, count, HEADERS.length - VISIBLE_COUNT).setFontColor('#9a9a9a').setFontSize(9);
  sheet.showColumns(1, VISIBLE_COUNT);
  sheet.hideColumns(VISIBLE_COUNT + 1, sheet.getMaxColumns() - VISIBLE_COUNT);
}

/* Синонимы шапок старых версий; порядок соответствует HEADERS. */
var HEADER_ALIASES = [
  ['имя', 'фио', 'гость'],
  ['телефон', 'контакты', 'контакт', 'номер телефона'],
  ['заезд/выезд', 'заезд / выезд', 'заезд-выезд', 'даты', 'даты проживания'],
  ['номер комнаты', 'номер', 'комната'],
  ['отчетные документы', 'отч.доки', 'отч. доки', 'документы', 'отч доки'],
  ['№заявки', '№ заявки', '№', 'номер заявки', 'id'],
  ['дата заявки', 'дата заяки', 'дата'],
  ['статус'],
  ['ref'],
  ['roomid']
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

function formatCellDate_(v) {
  var d = toDate_(v);
  return d ? Utilities.formatDate(d, TIMEZONE, 'dd.MM.yyyy') : String(v || '').trim();
}

/** Перед перестройкой сохраняет весь старый лист, включая убираемые поля. */
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

/** Переносит нужные поля по шапкам. Старые гости/комментарии остаются только в архиве. */
function migrateLayout_(sheet, allowMigration) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var lastRow = sheet.getLastRow();
  var oldHead = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h).trim(); });
  if (oldHead.join('|') === HEADERS.join('|')) return;
  if (!allowMigration) throw new Error('Обновите формат таблицы: запустите setup() в Apps Script.');
  var oldNorm = oldHead.map(normHead_);
  var idx = HEADER_ALIASES.map(function(aliases){ return findAliasIdx_(oldNorm, aliases); });
  var oldFromIdx = oldNorm.indexOf('заезд'), oldToIdx = oldNorm.indexOf('выезд');
  var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var rows = data.map(function(r, rowIdx){
    var out = HEADERS.map(function(h, i){ return idx[i] >= 0 ? r[idx[i]] : ''; });
    if (!out[COL.id]) out[COL.id] = rowIdx + 1;
    if (!out[COL.dates] && (oldFromIdx >= 0 || oldToIdx >= 0)) {
      var f = oldFromIdx >= 0 ? formatCellDate_(r[oldFromIdx]) : '';
      var t = oldToIdx >= 0 ? formatCellDate_(r[oldToIdx]) : '';
      out[COL.dates] = f && t ? f + ' – ' + t : f || t;
    }
    var id = roomId_(out[COL.roomId]) || roomId_(out[COL.room]);
    if (id) { out[COL.roomId] = id; out[COL.room] = ROOM_LABELS[id]; }
    out[COL.docs] = docsValue_(out[COL.docs]);
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

function findRecent_(phone, fromIso, toIso, roomId, docs, name) {
  return findRow_(function(r){
    if (phoneDigits_(r[COL.phone]) !== phoneDigits_(phone)) return false;
    if (normStatus_(r[COL.status]) !== STATUS_NEW) return false;
    var created = r[COL.created] ? new Date(r[COL.created]).getTime() : 0;
    if (!created || (Date.now() - created) > DEDUPE_MINUTES * 60000) return false;
    var range = parseDates_({ dates: r[COL.dates] });
    return range.fromIso === fromIso && range.toIso === toIso &&
      String(r[COL.roomId] || '').trim() === roomId && docsValue_(r[COL.docs]) === docs &&
      String(r[COL.name]).replace(/^'(?==)/, '').trim() === name;
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

/**
 * Даты заявки. Сначала пробуем ISO-поля dateFrom/dateTo с сайта,
 * затем разбираем человеческую строку вида «12.10.2026–15.10.2026 (3 сут.)».
 */
function parseDates_(data) {
  var out = { from: null, to: null, fromIso: '', toIso: '', nights: 0, pair: '', human: '' };
  var from = parseIso_(data.dateFrom);
  var to = parseIso_(data.dateTo);

  if (!from || !to) {
    var raw = String(data.dates || '').replace(/\(.*?\)/g, ' ');
    var m = raw.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s*(?:[–—\-\/]|по)\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/i);
    if (m) {
      var year = Number(m[6] || m[3] || new Date().getFullYear());
      if (year < 100) year += 2000;
      var y1 = Number(m[3] || year); if (y1 < 100) y1 += 2000;
      if (!m[6] && Number(m[5]) < Number(m[2])) year = y1 + 1;
      from = from || calendarDate_(y1, Number(m[2]), Number(m[1]));
      to = to || calendarDate_(year, Number(m[5]), Number(m[4]));
    }
  }

  if (from) { out.from = from; out.fromIso = Utilities.formatDate(from, TIMEZONE, 'yyyy-MM-dd'); }
  if (to) { out.to = to; out.toIso = Utilities.formatDate(to, TIMEZONE, 'yyyy-MM-dd'); }
  if (from && to) {
    var n = Math.round((startOfDay_(to) - startOfDay_(from)) / 86400000);
    out.nights = n > 0 ? n : 0;
    out.pair = Utilities.formatDate(from, TIMEZONE, 'dd.MM.yyyy') + ' – ' + Utilities.formatDate(to, TIMEZONE, 'dd.MM.yyyy');
  }
  out.human = out.pair; // не доверяем строке dates, когда сайт передал точные ISO-даты
  return out;
}

function calendarDate_(year, month, day) {
  var d = new Date(year, month - 1, day, 12, 0, 0);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

function parseIso_(v) {
  var m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? calendarDate_(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

function toDate_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  var m = String(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
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
function docsValue_(v) { return /^(да|нужны|yes|1|true|on)$/i.test(String(v || '').trim()) ? 'Да' : 'Нет'; }
function roomId_(value) {
  var s = String(value || '').trim();
  if (Object.prototype.hasOwnProperty.call(ROOM_LABELS, s)) return s;
  var ids = Object.keys(ROOM_LABELS);
  for (var i = 0; i < ids.length; i++) if (ROOM_LABELS[ids[i]].toLowerCase() === s.toLowerCase()) return ids[i];
  return '';
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
