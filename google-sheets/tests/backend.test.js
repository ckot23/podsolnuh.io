/**
 * Проверка google-sheets/Code.gs без Google: мок-таблица + мок Telegram.
 * Запуск:  node google-sheets/tests/backend.test.js
 * Зависимостей нет — нужен только Node.js.
 */
const { createEnv } = require('./mock-apps-script.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  →  ' + extra : '')); }
}

const env = createEnv();
const api = env.api;
let sheet = null;                       // создаётся в setup()
const post = (params, secretOk) => JSON.parse(api.doPost({
  parameter: secretOk ? Object.assign({ secret: 'podsolnuh-2026' }, params) : params,
  postData: { contents: JSON.stringify(params), type: 'application/json' }
}).getContent());
const get = params => JSON.parse(api.doGet({ parameter: params }).getContent());

console.log('\n1) setup() — создание листа');
api.setup();
sheet = env.sheet();
check('лист «Брони» создан', !!sheet);
check('шапка: видимые колонки в нужном порядке', sheet.getRange(1, 1, 1, 8).getValues()[0].join('|') ===
  '№заявки|Дата заявки|Имя|Контакты|Заезд/выезд|Количество человек|Отч.доки|Номер комнаты',
  sheet.getRange(1, 1, 1, 8).getValues()[0].join('|'));
check('служебные колонки есть и скрыты', sheet.getRange(1, 9, 1, 6).getValues()[0].join('|') ===
  'Статус|Ночей|Комментарий|Источник|Ref|RoomId' && sheet.hiddenCols.join(',') === '9,10,11,12,13,14',
  sheet.getRange(1, 9, 1, 6).getValues()[0].join('|') + ' hidden=' + sheet.hiddenCols);
check('выпадающий список статусов задан', sheet.validations.length > 0);

console.log('\n2) заявка с сайта (multipart: поля приходят в e.parameter)');
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const t = new Date();
const from = iso(t), to = iso(new Date(t.getTime() + 2 * 86400000));
const bookingParams = {
  action: 'book', name: 'Анна Петрова', phone: '+7 918 116-45-54', contacts: '+7 918 116-45-54',
  dates: '12.10.2026 – 14.10.2026 (2 сут.)', dateFrom: from, dateTo: to,
  nights: '2', guests: '2', people: '2', docs: 'да', room: 'single-1', roomLabel: 'Номер 1',
  comment: 'Заезд после 20:00',
  ref: 'p-test-0001', page: '/rooms.html'
};
const res1 = JSON.parse(api.doPost({
  parameter: bookingParams,
  postData: { contents: '------boundary\r\nContent-Disposition…', type: 'multipart/form-data; boundary=----boundary' }
}).getContent());
check('ответ ok', res1.ok === true, JSON.stringify(res1));
check('номер заявки = 1', res1.id === 1, JSON.stringify(res1));
check('уведомление модератору отправлено', res1.notified === true);
check('посчитано 2 ночи', res1.nights === 2, JSON.stringify(res1));

const row = sheet.getRange(2, 1, 1, 14).getValues()[0];
check('№заявки в 1-й колонке', row[0] === 1, String(row[0]));
check('дата заявки записана', row[1] instanceof Date, String(row[1]));
check('имя в таблице', row[2] === 'Анна Петрова', String(row[2]));
check('контакты в таблице', row[3] === '+7 918 116-45-54', String(row[3]));
check('заезд/выезд в одной колонке', /\d{2}\.\d{2}\.\d{4}\s*–\s*\d{2}\.\d{2}\.\d{4}/.test(String(row[4])), String(row[4]));
check('количество человек в таблице', String(row[5]) === '2', String(row[5]));
check('отч.доки записаны как «Да»', row[6] === 'Да', String(row[6]));
check('номер комнаты в видимой колонке', row[7] === 'Номер 1', String(row[7]));
check('статус «Новая»', row[8] === 'Новая', String(row[8]));
check('комментарий попал в таблицу', row[10] === 'Заезд после 20:00', String(row[10]));
check('roomId сохранён для статусов сайта', row[13] === 'single-1', String(row[13]));

const tgMsg = env.fetchLog.filter(f => /sendMessage/.test(f.url)).pop();
check('в Telegram ушло сообщение с кнопками', !!tgMsg && /ok:1/.test(tgMsg.payload.reply_markup) && /no:1/.test(tgMsg.payload.reply_markup));
check('в сообщении есть имя, телефон и номер', /Анна Петрова/.test(tgMsg.payload.text) && /918 116-45-54/.test(tgMsg.payload.text) && /Номер 1/.test(tgMsg.payload.text));
check('chat_id модератора', tgMsg.payload.chat_id === '7114829971', tgMsg.payload.chat_id);

console.log('\n3) защита от дублей и от ботов');
check('повтор по ref не создаёт новую строку', (r => r.duplicate === true && r.id === 1)(post(bookingParams)));
check('повтор по телефону+дате за 15 минут отсечён', (r => r.duplicate === true && r.id === 1)(post(Object.assign({}, bookingParams, { ref: 'p-test-0002' }))));
check('в таблице по-прежнему одна строка', sheet.getLastRow() === 2, String(sheet.getLastRow()));
check('ловушка для ботов игнорируется', (r => r.ignored === true)(post({ action: 'book', name: 'Бот Ботов', phone: '+79180000000', website: 'spam', ref: 'p-spam' })));
check('короткий телефон отклонён', post({ action: 'book', name: 'Иван', phone: '123', ref: 'p-bad' }).ok === false);

console.log('\n4) кнопки модератора в Telegram');
check('апдейт обработан', post({
  callback_query: { id: 'cb1', from: { id: 7114829971 }, data: 'ok:1', message: { message_id: 101, chat: { id: 7114829971 }, text: 'заявка №1' } }
}, true).ok === true);
check('статус в таблице стал «Подтверждена»', sheet.getRange(2, 9).getValues()[0][0] === 'Подтверждена', String(sheet.getRange(2, 9).getValues()[0][0]));
check('нажатие подтверждено в чате', env.fetchLog.some(f => /answerCallbackQuery/.test(f.url)));
check('сообщение переписано («Подтверждено»)', env.fetchLog.some(f => /editMessageText/.test(f.url)));
post({ callback_query: { id: 'cb2', from: { id: 999 }, data: 'no:1', message: { message_id: 101, chat: { id: 999 }, text: 'x' } } }, false);
check('без секрета в вебхуке апдейт игнорируется', sheet.getRange(2, 9).getValues()[0][0] === 'Подтверждена');

console.log('\n5) статусы номеров для сайта (GET ?action=status)');
const st = get({ action: 'status' });
check('номер 1 занят — подтверждённая бронь на сегодня', st.ok && st.statuses['single-1'] === 'busy', JSON.stringify(st.statuses));
check('остальные номера не заняты', Object.keys(st.statuses).length === 1, JSON.stringify(st.statuses));

console.log('\n6) подтверждение доставки (GET ?action=verify)');
check('свой ref найден', get({ action: 'verify', ref: 'p-test-0001' }).found === 1);
check('чужой ref не найден', get({ action: 'verify', ref: 'нет-такого' }).found === 0);

console.log('\n7) вебхук и проверка связи');
api.setupTelegram();
const wh = env.fetchLog.filter(f => /setWebhook/.test(f.url)).pop();
check('setupTelegram() ставит вебхук с секретом', !!wh && /secret=podsolnuh-2026/.test(wh.payload.url) && /exec/.test(wh.payload.url));
check('ping отвечает по таблице', get({ action: 'ping' }).rows === 1, JSON.stringify(get({ action: 'ping' })));
check('getMe видит бота', api.setup().indexOf('на связи') > -1, api.setup());

console.log('\n8) разбор дат');
const p1 = api.parseDates_({ dates: '12.10 – 15.10 (3 сут.)' });
check('без года: 3 ночи', p1.nights === 3 && !!p1.fromIso && !!p1.toIso, JSON.stringify(p1));
const p2 = api.parseDates_({ dates: '28.12.2026 – 02.01.2027 (5 сут.)' });
check('переход через год', p2.fromIso === '2026-12-28' && p2.toIso === '2027-01-02' && p2.nights === 5, JSON.stringify(p2));
const p3 = api.parseDates_({ dates: '01.03.2026 – 04.03.2026 (3 сут.)', dateFrom: '2026-03-01', dateTo: '2026-03-04' });
check('ISO-поля имеют приоритет', p3.nights === 3 && p3.fromIso === '2026-03-01', JSON.stringify(p3));

console.log('\n9) вторая заявка (другой номер и телефон)');
const res2 = post({ action: 'book', name: 'Пётр', phone: '+79189451223', dateFrom: from, dateTo: to, dates: 'x', room: 'studio-4', roomLabel: 'Номер 2', docs: 'нет', ref: 'p-test-0003' });
check('принята с номером 2', res2.ok === true && res2.id === 2, JSON.stringify(res2));
check('без галочки документов записано «Нет»', sheet.getRange(3, 7).getValues()[0][0] === 'Нет', String(sheet.getRange(3, 7).getValues()[0][0]));
check('номер комнаты записан в 8-ю колонку', sheet.getRange(3, 8).getValues()[0][0] === 'Номер 2', String(sheet.getRange(3, 8).getValues()[0][0]));
check('в таблице две строки', sheet.getLastRow() === 3, String(sheet.getLastRow()));

console.log('\n10) миграция со старых колонок (Заезд + Выезд → Заезд/выезд и синонимы)');
const envOld = createEnv();
const oldSheet = envOld.ss.insertSheet('Брони');
oldSheet.getRange(1, 1, 1, 11).setValues([[
  'Дата заявки', 'Имя', 'Телефон', 'Заезд', 'Выезд', 'Гостей', 'Документы', '№', 'Статус', 'Ночей', 'Номер'
]]);
oldSheet.getRange(2, 1, 1, 11).setValues([[
  new Date(2026, 9, 12, 10, 0), 'Ольга', '+79181112233', new Date(2026, 9, 15, 12, 0), new Date(2026, 9, 18, 12, 0), '3', 'Да', 7, 'Подтверждена', 3, 'Номер 4'
]]);
envOld.api.setup();
const migRow = oldSheet.getRange(2, 1, 1, 10).getValues()[0];
check('миграция сохранила №заявки, имя, контакты, людей, отч.доки, номер комнаты',
  migRow[0] === 7 && migRow[2] === 'Ольга' && migRow[3] === '+79181112233' && String(migRow[5]) === '3' && migRow[6] === 'Да' && migRow[7] === 'Номер 4',
  JSON.stringify(migRow));
check('миграция склеила Заезд и Выезд в Заезд/выезд',
  migRow[4] === '15.10.2026 – 18.10.2026',
  String(migRow[4]));

console.log('\nИтого: ' + pass + ' успешно, ' + fail + ' провалено\n');
process.exit(fail ? 1 : 0);
