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

/* Порядок колонок на листе: первые 8 видны, остальные служебные (скрыты). */
var HEADERS = [
  '№заявки',            // 1  видимая
  'Дата заявки',        // 2  видимая
  'Имя',                // 3  видимая
  'Контакты',           // 4  видимая
  'Заезд/выезд',        // 5  видимая
  'Количество человек', // 6  видимая
  'Отч.доки',           // 7  видимая: Да / Нет (нужны ли отчётные документы)
  'Номер комнаты',      // 8  видимая
  'Статус',             // 9  служебная (скрыта)
  'Ночей',              // 10 служебная (скрыта)
  'Комментарий',        // 11 служебная (скрыта)
  'Источник',           // 12 служебная (скрыта)
  'Ref',                // 13 технический: подтверждение доставки
  'RoomId'              // 14 технический: id номера для статусов на сайте
];

/* Индексы колонок (с нуля) — используйте их вместо чисел. */
var COL = {
  id: 0, created: 1, name: 2, contacts: 3, dates: 4, guests: 5, docs: 6, room: 7,
  status: 8, nights: 9, comment: 10, source: 11, ref: 12, roomId: 13
};
var VISIBLE_COUNT = 8;

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
  migrateLayout_(sheet);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#f7a93c')
    .setFontColor('#3a2a08')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);

  var widths = [85, 135, 150, 145, 175, 145, 95, 130, 130, 70, 240, 120, 90, 90];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

  // выпадающий список статусов
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_LIST, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, COL.status + 1, 1000, 1).setDataValidation(rule);

  // формат дат и выравнивание
  sheet.getRange(2, COL.id + 1, 1000, 1).setHorizontalAlignment('center');
  sheet.getRange(2, COL.created + 1, 1000, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(2, COL.dates + 1, 1000, 3).setHorizontalAlignment('center');
  sheet.getRange(2, COL.source + 1, 1000, 3).setFontColor('#9a9a9a').setFontSize(9);

  // служебные колонки скрыты (их можно открыть через меню «Показать столбцы»)
  sheet.showColumns(1, HEADERS.length);
  sheet.hideColumns(VISIBLE_COUNT + 1, HEADERS.length - VISIBLE_COUNT);

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
      var bot = tgCheck_(); // живой запрос к Telegram: «бот @… на связи» или текст ошибки
      return json_({
        ok: true,
        service: 'podsolnuh-booking',
        sheet: ss.getName(),
        sheetUrl: ss.getUrl(),
        rows: Math.max(0, getSheet_(ss).getLastRow() - 1),
        telegram: /на связи/.test(bot),
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
    var contacts = String(data.contacts || data.phone || '').trim();
    if (name.length < 2) return { ok: false, error: 'Укажите имя.' };
    if (digits_(contacts).length < 10) return { ok: false, error: 'Укажите телефон.' };

    var ref = String(data.ref || '').trim();
    if (ref) {
      var dup = findRef_(ref);
      if (dup) return { ok: true, id: dup, duplicate: true, message: 'Заявка №' + dup + ' уже принята.' };
    }

    var range = parseDates_(data);
    var guests = String(data.people || data.guests || '').trim() || '—';
    var roomLabel = String(data.roomNumber || data.roomLabel || data.room || '').trim() || 'не выбран';
    var roomId = String(data.roomId || data.room || '').trim();
    var nights = range.nights || toNumber_(data.nights);
    var docs = /^(да|нужны|yes|1|true|on)$/i.test(String(data.docs || '').trim()) ? 'Да' : 'Нет';
    var comment = String(data.comment || '').trim();
    var source = String(data.page || data.source || '').trim();

    // защита от повторной отправки той же заявки в течение DEDUPE_MINUTES
    var recent = findRecent_(contacts, range.fromIso, roomId);
    if (recent) return { ok: true, id: recent, duplicate: true, message: 'Заявка №' + recent + ' уже принята.' };

    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss);
    var row = sheet.getLastRow() + 1;
    var num = row - 1;
    var createdAt = new Date();
    var datesCell = range.pair || range.human || '';

    var values = [];
    values[COL.id] = num;
    values[COL.created] = createdAt;
    values[COL.name] = name;
    values[COL.contacts] = contacts;
    values[COL.dates] = datesCell;
    values[COL.guests] = guests;
    values[COL.docs] = docs;
    values[COL.room] = roomLabel;
    values[COL.status] = STATUS_NEW;
    values[COL.nights] = nights || '';
    values[COL.comment] = comment;
    values[COL.source] = source;
    values[COL.ref] = ref;
    values[COL.roomId] = roomId;
    sheet.getRange(row, 1, 1, HEADERS.length).setValues([values]);
    sheet.getRange(row, COL.id + 1).setHorizontalAlignment('center');
    sheet.getRange(row, COL.created + 1).setNumberFormat('dd.MM.yyyy HH:mm');
    sheet.getRange(row, COL.dates + 1, 1, 3).setHorizontalAlignment('center');
    sheet.getRange(row, COL.source + 1, 1, 3).setFontColor('#9a9a9a').setFontSize(9);

    var booking = {
      id: num,
      created: createdAt,
      name: name,
      contacts: contacts,
      datesHuman: range.human || datesCell,
      from: range.fromIso,
      to: range.toIso,
      nights: nights,
      guests: guests,
      docs: docs,
      room: roomLabel,
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
      nights: nights
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
    '🕒 <b>Дата заявки:</b> ' + Utilities.formatDate(b.created || new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm'),
    '👤 <b>Имя:</b> ' + esc_(b.name),
    '📞 <b>Контакты:</b> <code>' + esc_(b.contacts) + '</code>',
    '📅 <b>Заезд/выезд:</b> ' + esc_(datesLine_(b)),
    '👥 <b>Количество человек:</b> ' + esc_(b.guests),
    '📄 <b>Отч. доки:</b> ' + (b.docs === 'Да' ? 'Да (нужны)' : 'Нет'),
    '🛏 <b>Номер комнаты:</b> ' + esc_(b.room),
    b.comment ? '💬 <b>Комментарий:</b> ' + esc_(b.comment) : ''
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
    var created = r[COL.created] ? Utilities.formatDate(new Date(r[COL.created]), TIMEZONE, 'dd.MM.yyyy') : '';
    if (created !== stamp) return;
    out.push('• №' + r[COL.id] + ' — ' + r[COL.name] + ', ' + r[COL.contacts] + ', ' + r[COL.room] + ', ' + String(r[COL.status]).toLowerCase());
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
      var status = normStatus_(r[COL.status]);
      var roomId = String(r[COL.roomId] || '').trim();
      if (!roomId) return;
      if (status !== STATUS_OK && status !== STATUS_IN) return;
      var range = parseDates_({ dates: r[COL.dates] });
      var from = range.from || toDate_(r[COL.dates]);
      if (!from) return;
      var to = range.to || new Date(from.getTime() + 86400000);
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
  var ids = sheet.getRange(2, COL.id + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (parseInt(ids[i][0], 10) === id) {
      sheet.getRange(i + 2, COL.status + 1).setValue(status);
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
    migrateLayout_(sheet);
  }
  return sheet;
}

/**
 * Приводит лист к актуальному порядку колонок HEADERS.
 * Данные переносятся по названиям колонок (с учётом синонимов и склейки Заезд + Выезд),
 * поэтому старые брони не теряются.
 */
var HEADER_ALIASES = [
  ['№заявки', '№ заявки', '№', 'номер заявки', 'id'],
  ['дата заявки', 'дата заяки', 'дата'],
  ['имя', 'фио', 'гость'],
  ['контакты', 'телефон', 'контакт', 'номер телефона'],
  ['заезд/выезд', 'заезд / выезд', 'заезд-выезд', 'даты', 'даты проживания'],
  ['количество человек', 'кол-во человек', 'гостей', 'количество гостей', 'человек'],
  ['отч.доки', 'отч. доки', 'отчетные документы', 'документы', 'отч доки'],
  ['номер комнаты', 'номер', 'комната'],
  ['статус'],
  ['ночей', 'суток'],
  ['комментарий', 'пожелания'],
  ['источник'],
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
  if (d) return Utilities.formatDate(d, TIMEZONE, 'dd.MM.yyyy');
  return String(v || '').trim();
}

function migrateLayout_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var lastRow = sheet.getLastRow();
  var oldHead = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  if (oldHead.slice(0, HEADERS.length).join('|') === HEADERS.join('|') && lastCol <= HEADERS.length) return;

  var oldNorm = oldHead.map(normHead_);
  var idx = HEADER_ALIASES.map(function (aliases) { return findAliasIdx_(oldNorm, aliases); });
  var oldFromIdx = oldNorm.indexOf('заезд');
  var oldToIdx = oldNorm.indexOf('выезд');

  var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var rows = data.map(function (r, rowIdx) {
    var outRow = HEADERS.map(function (h, i) { return idx[i] >= 0 ? r[idx[i]] : ''; });
    if (!outRow[COL.id]) outRow[COL.id] = rowIdx + 1;
    if (!outRow[COL.dates] && (oldFromIdx >= 0 || oldToIdx >= 0)) {
      var fStr = oldFromIdx >= 0 ? formatCellDate_(r[oldFromIdx]) : '';
      var tStr = oldToIdx >= 0 ? formatCellDate_(r[oldToIdx]) : '';
      outRow[COL.dates] = (fStr && tStr) ? (fStr + ' – ' + tStr) : (fStr || tStr);
    }
    return outRow;
  });

  sheet.showColumns(1, Math.max(lastCol, HEADERS.length));
  sheet.getRange(1, 1, Math.max(lastRow, 1), Math.max(lastCol, HEADERS.length)).clearContent();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  if (rows.length) sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.hideColumns(VISIBLE_COUNT + 1, HEADERS.length - VISIBLE_COUNT);
}

function sheetUrl_(ss, sheet) {
  return ss.getUrl() + '#gid=' + sheet.getSheetId();
}

function findRef_(ref) {
  if (!ref) return 0;
  return findRow_(function (r) { return String(r[COL.ref] || '').trim() === ref; });
}

function findRecent_(phone, fromIso, roomId) {
  var d = digits_(phone);
  return findRow_(function (r) {
    if (digits_(r[COL.contacts]) !== d) return false;
    if (normStatus_(r[COL.status]) !== STATUS_NEW) return false;
    var created = r[COL.created] ? new Date(r[COL.created]).getTime() : 0;
    if (!created || (Date.now() - created) > DEDUPE_MINUTES * 60000) return false;
    if (fromIso) {
      var range = parseDates_({ dates: r[COL.dates] });
      if (range.fromIso && range.fromIso !== fromIso) return false;
    }
    if (roomId && String(r[COL.roomId] || '').trim() !== roomId) return false;
    return true;
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
      from = from || new Date(y1, Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
      to = to || new Date(year, Number(m[5]) - 1, Number(m[4]), 12, 0, 0);
    }
  }

  if (from) { out.from = from; out.fromIso = Utilities.formatDate(from, TIMEZONE, 'yyyy-MM-dd'); }
  if (to) { out.to = to; out.toIso = Utilities.formatDate(to, TIMEZONE, 'yyyy-MM-dd'); }
  if (from && to) {
    var n = Math.round((startOfDay_(to) - startOfDay_(from)) / 86400000);
    out.nights = n > 0 ? n : 0;
    out.pair = Utilities.formatDate(from, TIMEZONE, 'dd.MM.yyyy') + ' – ' + Utilities.formatDate(to, TIMEZONE, 'dd.MM.yyyy');
  }
  out.human = String(data.dates || '').trim() || out.pair;
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
