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
 *   2. Вставьте этот код целиком, заполните блок НАСТРОЙКИ ниже.
 *   3. Запустите функцию setup() и разрешите доступ.
 *   4. Развернуть → Новое развёртывание → Веб-приложение →
 *      «Запуск от имени: я», «Доступ: все, у кого есть ссылка».
 *   5. Скопируйте URL /exec и вставьте на сайте в админ-панели в поле
 *      «Google-таблица броней», либо в data/site.json → cfg.bookingApi.
 * ============================================================================
 */

/* ============================== НАСТРОЙКИ ================================ */

/** Токен бота из @BotFather. ВАЖНО: старый токен, лежавший в data/site.json,
 *  отзовите и создайте новый — он был виден всем посетителям сайта. */
var BOT_TOKEN = 'ВСТАВЬТЕ_ТОКЕН_БОТА';

/** Кому присылать заявки: chat_id модератора. Несколько получателей — через запятую. */
var MODERATOR_CHAT_ID = '7114829971';

/** ID Google-таблицы (из её адреса: docs.google.com/spreadsheets/d/<ID>/edit).
 *  Если скрипт создан ВНУТРИ таблицы (Расширения → Apps Script) — оставьте пустым. */
var SHEET_ID = '';

/** Имя листа для броней. Создастся автоматически, если его нет. */
var SHEET_NAME = 'Брони';

/** Секрет для вебхука Telegram (кнопки «Подтвердить»). Придумайте свою строку. */
var WEBHOOK_SECRET = 'podsolnuh-2026';

/** Часовой пояс для дат и времени в таблице и в сообщениях. */
var TIMEZONE = 'Europe/Moscow';

/** Ключ защиты от повторной отправки одной и той же заявки (в минутах). */
var DEDUPE_MINUTES = 15;

/* =========================== КОНЕЦ НАСТРОЕК ============================== */

var HEADERS = [
  '№',                // 1
  'Дата заявки',      // 2
  'Статус',           // 3
  'Имя',              // 4
  'Телефон',          // 5
  'Заезд',            // 6
  'Выезд',            // 7
  'Ночей',            // 8
  'Гостей',           // 9
  'Номер',            // 10
  'Цена/сутки',       // 11
  'Сумма',            // 12
  'Комментарий',      // 13
  'Источник',         // 14
  'Ref',              // 15 (технический: подтверждение доставки)
  'RoomId'            // 16 (технический: id номера для статусов на сайте)
];

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
  var ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(TIMEZONE);
  var sheet = getSheet_(ss);

  // аккуратные ширины и оформление
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#f7a93c')
    .setFontColor('#3a2a08')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);

  var widths = [55, 130, 130, 150, 140, 100, 100, 70, 80, 130, 100, 110, 240, 120, 90, 90];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

  // выпадающий список статусов
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_LIST, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 3, 1000, 1).setDataValidation(rule);

  // перенос длинных текстов и формат дат/денег
  sheet.getRange('F2:G1000').setNumberFormat('dd.MM.yyyy');
  sheet.getRange('K2:L1000').setNumberFormat('# ##0 ₽');
  sheet.getRange('F2:G1000').setHorizontalAlignment('center');
  sheet.getRange('N2:P1000').setFontColor('#9a9a9a').setFontSize(9);

  PROP.setProperty('SHEET_ID', SHEET_ID);
  PROP.setProperty('SHEET_NAME', SHEET_NAME);

  var check = tgCheck_();
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }

  Logger.log(
    'Таблица готова: ' + ss.getName() + ' / лист «' + sheet.getName() + '».\n' +
    'Telegram: ' + check + '\n' +
    'URL веб-приложения: ' + (url || 'ещё не развёрнуто (Развернуть → Новое развёртывание → Веб-приложение)')
  );
  return check;
}

/**
 * Подключить кнопки «Подтвердить / Отклонить» в Telegram.
 * Требует, чтобы веб-приложение уже было развёрнуто (URL /exec).
 * Запускать один раз; при смене WEBHOOK_SECRET — снова.
 */
function setupTelegram() {
  var url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Сначала разверните веб-приложение (Развернуть → Новое развёртывание).');
  var res = tg_('setWebhook', {
    url: url + '?secret=' + encodeURIComponent(WEBHOOK_SECRET),
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
      return json_({
        ok: true,
        service: 'podsolnuh-booking',
        sheet: ss.getName(),
        sheetUrl: ss.getUrl(),
        rows: Math.max(0, getSheet_(ss).getLastRow() - 1),
        telegram: !!getChatIds_().length,
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
      handleTelegramUpdate_(parsed, (e && e.parameter && e.parameter.secret) === WEBHOOK_SECRET);
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
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) { /* продолжаем без блокировки */ }

  try {
    // ловушка для ботов: скрытое поле должно быть пустым
    if (String(data.website || '').trim()) return { ok: true, ignored: true };

    var name = String(data.name || '').trim();
    var phone = String(data.phone || '').trim();
    if (name.length < 2) return { ok: false, error: 'Укажите имя.' };
    if (digits_(phone).length < 10) return { ok: false, error: 'Укажите телефон.' };

    var ref = String(data.ref || '').trim();
    if (ref) {
      var dup = findRef_(ref);
      if (dup) return { ok: true, id: dup, duplicate: true, message: 'Заявка №' + dup + ' уже принята.' };
    }

    var range = parseDates_(data);
    var guests = String(data.guests || '').trim() || '—';
    var roomLabel = String(data.roomLabel || data.room || '').trim() || 'не выбран';
    var roomId = String(data.room || '').trim();
    var price = toNumber_(data.price);
    var nights = range.nights || toNumber_(data.nights);
    var total = (price && nights) ? price * nights : toNumber_(data.total);
    var comment = String(data.comment || '').trim();
    var source = String(data.page || data.source || '').trim();

    // защита от повторной отправки той же заявки в течение DEDUPE_MINUTES
    var recent = findRecent_(phone, range.fromIso, roomId);
    if (recent) return { ok: true, id: recent, duplicate: true, message: 'Заявка №' + recent + ' уже принята.' };

    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss);
    var row = sheet.getLastRow() + 1;
    var num = row - 1;

    sheet.getRange(row, 1, 1, HEADERS.length).setValues([[
      num,
      new Date(),
      STATUS_NEW,
      name,
      phone,
      range.from || '',
      range.to || '',
      nights || '',
      guests,
      roomLabel,
      price || '',
      total || '',
      comment,
      source,
      ref,
      roomId
    ]]);
    sheet.getRange(row, 2).setNumberFormat('dd.MM.yyyy HH:mm');
    sheet.getRange(row, 6, 1, 2).setNumberFormat('dd.MM.yyyy');
    sheet.getRange(row, 6, 1, 4).setHorizontalAlignment('center');
    sheet.getRange(row, 11, 1, 2).setNumberFormat('# ##0 ₽');
    sheet.getRange(row, 15, 1, 2).setFontColor('#9a9a9a').setFontSize(9);

    var booking = {
      id: num,
      name: name,
      phone: phone,
      datesHuman: range.human || String(data.dates || '').trim(),
      from: range.fromIso,
      to: range.toIso,
      nights: nights,
      guests: guests,
      room: roomLabel,
      price: price,
      total: total,
      comment: comment,
      source: source,
      sheetUrl: sheetUrl_(ss, sheet)
    };

    var notified = notifyModerator_(booking);
    return {
      ok: true,
      id: num,
      message: 'Заявка №' + num + ' принята.',
      row: row,
      notified: notified,
      nights: nights,
      total: total
    };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/* ========================= УВЕДОМЛЕНИЕ В TELEGRAM ======================== */

function notifyModerator_(b) {
  var ids = getChatIds_();
  if (!ids.length || !BOT_TOKEN) return false;

  var lines = [
    '🌻 <b>Новая заявка №' + b.id + '</b>',
    '',
    '👤 <b>Имя:</b> ' + esc_(b.name),
    '📞 <b>Телефон:</b> <code>' + esc_(b.phone) + '</code>',
    '📅 <b>Даты:</b> ' + esc_(datesLine_(b)),
    '👥 <b>Гостей:</b> ' + esc_(b.guests),
    '🛏 <b>Номер:</b> ' + esc_(b.room),
    b.total ? '💰 <b>Сумма:</b> ' + money_(b.total) + (b.price ? ' (' + money_(b.price) + '/сутки)' : '') : '',
    b.comment ? '💬 <b>Комментарий:</b> ' + esc_(b.comment) : '',
    '🕒 ' + Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm')
  ].filter(String);

  if (b.source) lines.push('🌐 Источник: ' + esc_(b.source));
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
    if (allowed.length && allowed.indexOf(from) === -1) {
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
      var head = original.split('\n').slice(0, 2).join('\n');
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
    if (!allowed.length || allowed.indexOf(chatId) !== -1) {
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
          text: busy.length ? ('🚫 Заняты сегодня: ' + busy.join(', ')) : '🌻 Сегодня все номера свободны.',
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
    var created = r[1] ? Utilities.formatDate(new Date(r[1]), TIMEZONE, 'dd.MM.yyyy') : '';
    if (created !== stamp) return;
    out.push('• №' + r[0] + ' — ' + r[3] + ', ' + r[4] + ', ' + r[9] + ', ' + String(r[2]).toLowerCase());
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
    var today = startOfDay_(new Date());
    rows.forEach(function (r) {
      var status = normStatus_(r[2]);
      var roomId = String(r[15] || '').trim();
      if (!roomId) return;
      if (status !== STATUS_OK && status !== STATUS_IN) return;
      var from = toDate_(r[5]);
      if (!from) return;
      var to = toDate_(r[6]) || new Date(from.getTime() + 86400000);
      if (today.getTime() >= startOfDay_(from).getTime() && today.getTime() < startOfDay_(to).getTime()) {
        out[roomId] = 'busy';
      }
    });
  } catch (err) {
    console.error('computeStatuses_: ' + err);
  }
  return out;
}

/** Меняет статус в строке с номером заявки. Возвращает true при успехе. */
function setStatusById_(id, status) {
  var sheet = getSheet_(getSpreadsheet_());
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (parseInt(ids[i][0], 10) === id) {
      sheet.getRange(i + 2, 3).setValue(status);
      return true;
    }
  }
  return false;
}

/* ============================== ХЕЛПЕРЫ ================================== */

function getSpreadsheet_() {
  var id = SHEET_ID || PROP.getProperty('SHEET_ID') || '';
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Укажите SHEET_ID в настройках скрипта.');
}

function getSheet_(ss) {
  var name = SHEET_NAME || PROP.getProperty('SHEET_NAME') || 'Брони';
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else {
    // дописываем отсутствующие технические колонки в старой шапке
    var head = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    var missing = false;
    HEADERS.forEach(function (h, i) { if (!head[i]) { head[i] = h; missing = true; } });
    if (missing) sheet.getRange(1, 1, 1, HEADERS.length).setValues([head]);
  }
  return sheet;
}

function sheetUrl_(ss, sheet) {
  return ss.getUrl() + '#gid=' + sheet.getSheetId();
}

function findRef_(ref) {
  if (!ref) return 0;
  return findRow_(function (r) { return String(r[14] || '').trim() === ref; });
}

function findRecent_(phone, fromIso, roomId) {
  var d = digits_(phone);
  return findRow_(function (r) {
    if (digits_(r[4]) !== d) return false;
    if (normStatus_(r[2]) !== STATUS_NEW) return false;
    var created = r[1] ? new Date(r[1]).getTime() : 0;
    if (!created || (Date.now() - created) > DEDUPE_MINUTES * 60000) return false;
    if (fromIso) {
      var f = toDate_(r[5]);
      var iso = f ? Utilities.formatDate(f, TIMEZONE, 'yyyy-MM-dd') : '';
      if (iso && iso !== fromIso) return false;
    }
    if (roomId && String(r[15] || '').trim() !== roomId) return false;
    return true;
  });
}

function findRow_(predicate) {
  var sheet = getSheet_(getSpreadsheet_());
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) return parseInt(rows[i][0], 10) || (i + 1);
  }
  return 0;
}

/**
 * Даты заявки. Сначала пробуем ISO-поля dateFrom/dateTo с сайта,
 * затем разбираем человеческую строку вида «12.10.2026–15.10.2026 (3 сут.)».
 */
function parseDates_(data) {
  var out = { from: null, to: null, fromIso: '', toIso: '', nights: 0, human: '' };
  var from = parseIso_(data.dateFrom);
  var to = parseIso_(data.dateTo);

  if (!from || !to) {
    var raw = String(data.dates || '').replace(/\(.*?\)/g, ' ');
    var m = raw.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s*[–—\-]\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
    if (m) {
      var year = Number(m[6] || m[3] || new Date().getFullYear());
      if (year < 100) year += 2000;
      var y1 = Number(m[3] || year); if (y1 < 100) y1 += 2000;
      from = from || new Date(y1, Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
      to = to || new Date(year, Number(m[5]) - 1, Number(m[4]), 12, 0, 0);
    }
  }

  if (from) { out.from = from; out.fromIso = Utilities.formatDate(from, TIMEZONE, 'yyyy-MM-dd'); }
  if (to) { out.to = to; out.toIso = Utilities.formatDate(to, TIMEZONE, 'yyyy-MM-dd'); }
  if (from && to) {
    var n = Math.round((startOfDay_(to) - startOfDay_(from)) / 86400000);
    out.nights = n > 0 ? n : 0;
  }
  out.human = String(data.dates || '').trim();
  if (!out.human && from && to) {
    out.human = Utilities.formatDate(from, TIMEZONE, 'dd.MM.yyyy') + '–' + Utilities.formatDate(to, TIMEZONE, 'dd.MM.yyyy');
  }
  return out;
}

function parseIso_(v) {
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
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
function toNumber_(v) {
  var n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function money_(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
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
  return String(MODERATOR_CHAT_ID || '')
    .split(/[,\s;]+/)
    .map(function (s) { return s.trim(); })
    .filter(String);
}

function tgCheck_() {
  if (!BOT_TOKEN || BOT_TOKEN.indexOf('ВСТАВЬТЕ') === 0) return 'токен бота не указан';
  var me = tg_('getMe', {});
  if (me && me.ok) return 'бот @' + me.result.username + ' на связи';
  return 'ошибка: ' + JSON.stringify(me);
}

function tg_(method, payload) {
  if (!BOT_TOKEN || BOT_TOKEN.indexOf('ВСТАВЬТЕ') === 0) return { ok: false, description: 'BOT_TOKEN не настроен' };
  try {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
    return JSON.parse(res.getContentText());
  } catch (err) {
    console.error('tg_ ' + method + ': ' + err);
    return { ok: false, description: String(err) };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
