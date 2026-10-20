/**
 * Автопроверка приёма заявки (только Имя и Номер телефона), новой таблицы и Telegram.
 * Запуск: node google-sheets/tests/backend.test.js (только Node.js, без зависимостей).
 */
const { createEnv } = require('./mock-apps-script.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}
function requests(env) {
  return {
    post: params => JSON.parse(env.api.doPost({ parameter: params, postData: { contents: JSON.stringify(params), type: 'application/json' } }).getContent()),
    urlencoded: params => JSON.parse(env.api.doPost({ parameter: {}, postData: { contents: new URLSearchParams(params).toString(), type: 'application/x-www-form-urlencoded' } }).getContent()),
    multipart: params => {
      const boundary = '----FormBoundaryTest';
      const body = Object.entries(params).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`).join('\r\n') + `\r\n--${boundary}--`;
      return JSON.parse(env.api.doPost({ parameter: {}, postData: { contents: body, type: 'multipart/form-data; boundary=' + boundary } }).getContent());
    },
    get: params => JSON.parse(env.api.doGet({ parameter: params }).getContent())
  };
}

const booking = {
  action: 'book',
  name: 'Анна Петрова',
  phone: '+7 918 116-45-54',
  ref: 'p-test-0001'
};
const messages = env => env.fetchLog.filter(f => /sendMessage/.test(f.url));
const readRow = (env, row = 2) => env.sheet().getRange(row, 1, 1, env.api.headers.length).getValues()[0];

console.log('\n1) setup и новая таблица — только две колонки (Имя и Номер телефона)');
const env = createEnv({ initialSheetName: 'Лист1' });
const api = env.api, req = requests(env), col = api.columns;
api.setup();
const sheet = env.sheet();
check('пустой «Лист1» в новой таблице переименован в «Брони»', sheet && sheet.getName() === 'Брони' && env.ss.sheets.length === 1);
check('в таблице ровно 2 колонки: Имя и Номер телефона', api.headers.join('|') === 'Имя|Номер телефона');
check('шапка записана в строку 1', sheet.getRange(1, 1, 1, 2).getValues()[0].join('|') === 'Имя|Номер телефона');
check('нет скрытых или лишних служебных колонок', sheet.hiddenCols.length === 0 && sheet.getLastColumn() === 2);
check('колонки имеют текстовый формат @', sheet.formats.some(f => f.col === 1 && f.numCols === 2 && f.format === '@'));
check('id таблицы сохранён в свойствах скрипта', env.props.get('SHEET_ID') === 'TESTID');

console.log('\n2) приём заявки с сайта (только имя и номер телефона)');
const res = req.urlencoded(booking);
check('заявка принята (x-www-form-urlencoded)', res.ok === true && res.id === 1, JSON.stringify(res));
check('уведомление в Telegram отправлено', res.notified === true);
const row = readRow(env);
check('имя записано в колонку A', row[col.name] === booking.name);
check('номер телефона записан в колонку B без потери плюса', row[col.phone] === booking.phone);
check('в строке ровно 2 ячейки и в листе 2 колонки', row.length === 2 && sheet.getLastColumn() === 2);
const tg = messages(env).at(-1);
check('в Telegram пришло имя и номер телефона', ['Новая заявка №1', 'Анна Петрова', booking.phone].every(t => tg.payload.text.includes(t)));
const notificationEvent = env.events.findIndex(e => e.type === 'telegram' && /sendMessage/.test(e.url));
const writeEvent = env.events.findIndex(e => e.type === 'sheet-write' && e.row === 2);
check('запись в таблицу и flush выполнены до отправки в Telegram', writeEvent > -1 && env.events.slice(writeEvent + 1, notificationEvent).some(e => e.type === 'flush'));

console.log('\n3) работа без ручного запуска setup() в только что созданной таблице');
const autoEnv = createEnv({ initialSheetName: 'Лист1' });
const autoRes = requests(autoEnv).multipart({ name: 'Иван', phone: '+7 918 222-33-44', ref: 'p-auto-1' });
check('первая заявка сама создаёт шапку и записывает строку 2', autoRes.ok === true && autoRes.id === 1 && autoEnv.sheet().getLastRow() === 2);
check('шапка в новой таблице: Имя | Номер телефона', autoEnv.sheet().getRange(1, 1, 1, 2).getValues()[0].join('|') === 'Имя|Номер телефона');
check('данные гостя записаны в строку 2', autoEnv.sheet().getRange(2, 1, 1, 2).getValues()[0].join('|') === 'Иван|+7 918 222-33-44');

console.log('\n4) защита от дублей и проверка доставки');
const messageCount = messages(env).length;
check('повтор по ref возвращает исходный id', (r => r.ok && r.duplicate && r.id === 1)(req.post(booking)));
check('повтор тех же имени и телефона за 15 минут отсечён', (r => r.duplicate && r.id === 1)(req.post({ ...booking, ref: 'p-test-0002' })));
check('телефоны с 8 и +7 считаются одинаковыми', req.post({ ...booking, phone: '8 918 116-45-54', ref: 'p-normalized' }).duplicate === true);
check('дубль не создаёт лишнюю строку в таблице и сообщение в Telegram', sheet.getLastRow() === 2 && messages(env).length === messageCount);
check('verify подтверждает записанный ref', req.get({ action: 'verify', ref: booking.ref }).found === 1);
check('verify возвращает 0 для неизвестного ref', req.get({ action: 'verify', ref: 'нет-такого' }).found === 0);
check('ловушка для спам-ботов игнорируется', req.post({ ...booking, ref: 'p-spam', website: 'spam' }).ignored === true);
check('ловушка не добавляет строку', sheet.getLastRow() === 2);

console.log('\n5) валидация имени и номера телефона');
const bad = createEnv(); bad.api.setup();
const badReq = requests(bad);
const invalidCases = [
  ['пустое имя', { name: '' }],
  ['слишком короткое имя', { name: 'А' }],
  ['слишком длинное имя', { name: 'А'.repeat(101) }],
  ['пустой телефон', { phone: '' }],
  ['короткий телефон', { phone: '12345' }],
  ['телефон длиннее 15 цифр', { phone: '1234567890123456' }],
  ['буквы в телефоне', { phone: 'позвоните 79181112233' }],
  ['невалидный ref', { ref: '=HYPERLINK()' }],
  ['неизвестное действие', { action: 'delete' }]
];
invalidCases.forEach(([label, fields], i) => {
  check(label + ' отклонён', badReq.post({ ...booking, ref: 'p-invalid-' + i, ...fields }).ok === false);
});
check('невалидные запросы не пишутся в таблицу', bad.sheet().getLastRow() === 1 && messages(bad).length === 0);

console.log('\n6) ping, безопасность и независимость от ошибок Telegram');
const ping = req.get({ action: 'ping' });
check('ping возвращает схему v4 и два поля Имя | Номер телефона', ping.ok && ping.schemaVersion === 4 && ping.fields.join('|') === 'Имя|Номер телефона');
check('публичный ping не раскрывает токен бота', !JSON.stringify(ping).includes('TEST-TOKEN'));

const noTg = createEnv({ properties: { BOT_TOKEN: '' } });
const noTgRes = requests(noTg).post(booking);
check('при пустом токене Telegram заявка всё равно сохраняется в таблицу', noTgRes.ok === true && noTgRes.notified === false && noTg.sheet().getLastRow() === 2);

const escaped = createEnv(); escaped.api.setup();
const escapedReq = requests(escaped);
check('имя с «=» экранируется от формул', escapedReq.post({ ...booking, name: '=SUM(1,2)', ref: 'p-formula' }).ok === true && readRow(escaped)[col.name] === "'=SUM(1,2)");
escapedReq.post({ ...booking, name: '<b>Анна & Иван</b>', ref: 'p-html' });
check('HTML-символы экранируются в сообщении Telegram', messages(escaped).at(-1).payload.text.includes('&lt;b&gt;Анна &amp; Иван&lt;/b&gt;'));

console.log('\nИтого: ' + pass + ' успешно, ' + fail + ' провалено\n');
process.exit(fail ? 1 : 0);
