/**
 * Автопроверка приёма заявки (только имя и контакты), таблицы, миграции и Telegram без Google-аккаунта.
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
    multipart: params => JSON.parse(env.api.doPost({ parameter: params, postData: { contents: '------boundary\\r\\nContent-Disposition…', type: 'multipart/form-data; boundary=----boundary' } }).getContent()),
    update: (update, secret = env.props.get('WEBHOOK_SECRET')) => JSON.parse(env.api.doPost({ parameter: { secret }, postData: { contents: JSON.stringify(update) } }).getContent()),
    get: params => JSON.parse(env.api.doGet({ parameter: params }).getContent())
  };
}

const booking = {
  action: 'book',
  name: 'Анна Петрова',
  phone: '+7 918 116-45-54',
  contacts: '+7 918 116-45-54',
  ref: 'p-test-0001'
};
const messages = env => env.fetchLog.filter(f => /sendMessage/.test(f.url));
const archives = env => env.ss.sheets.filter(s => / — архив /.test(s.name));
const readRow = (env, row = 2) => env.sheet().getRange(row, 1, 1, env.api.headers.length).getValues()[0];

console.log('\n1) setup — только два видимых поля (Имя и Контакты)');
const env = createEnv();
const api = env.api, req = requests(env), col = api.columns;
api.setup();
const sheet = env.sheet();
check('лист «Брони» создан', !!sheet);
check('видны только Имя и Контакты', sheet.getRange(1, 1, 1, 2).getValues()[0].join('|') === 'Имя|Контакты');
check('служебные колонки не содержат дат/номеров/документов/гостей', api.headers.slice(2).join('|') === '№заявки|Дата заявки|Статус|Ref');
check('все служебные колонки скрыты, видимы только 1 и 2', [3, 4, 5, 6].every(c => sheet.hiddenCols.includes(c)) && [1, 2].every(c => !sheet.hiddenCols.includes(c)));
check('правило статусов стоит в колонке Статус', sheet.validations.length === 1 && sheet.validations[0].col === col.status + 1);
check('контакты имеют текстовый формат', sheet.formats.some(f => f.col <= col.contacts + 1 && f.col + f.numCols > col.contacts + 1 && f.format === '@'));
check('реальный id таблицы сохранён для веб-приложения', env.props.get('SHEET_ID') === 'TESTID');
check('повторный setup не создаёт архив текущего формата', (api.setup(), archives(env).length === 0));

console.log('\n2) минимальная заявка с сайта: только имя и контакты');
const res = req.multipart(booking);
check('multipart принят и записан без номера комнаты и дат', res.ok === true && res.id === 1, JSON.stringify(res));
check('уведомление отправлено', res.notified === true);
const row = readRow(env);
check('имя сохранено', row[col.name] === booking.name);
check('контакты сохранены без потери плюса', row[col.contacts] === booking.contacts);
check('служебный id, дата и статус сохранены', row[col.id] === 1 && row[col.created] instanceof Date && row[col.status] === 'Новая');
check('ref сохранён', row[col.ref] === booking.ref);
check('нет лишних колонок и значений', sheet.getLastColumn() === 6 && row.length === 6);
const tg = messages(env).at(-1);
check('заголовок «Новая заявка»', tg.payload.text.includes('Новая заявка №1'));
check('в Telegram есть имя и контакты', ['Анна Петрова', booking.contacts].every(t => tg.payload.text.includes(t)));
check('в Telegram нет убранных полей', !/Номер комнаты|Заезд\/выезд|Отчётные документы|Количество человек|Комментарий|Источник/.test(tg.payload.text));
check('сообщение отправлено настроенному модератору', tg.payload.chat_id === '7114829971');
check('кнопки модерации и таблицы сохранены', ['ok:1', 'no:1', 'TESTID'].every(t => tg.payload.reply_markup.includes(t)));
const notificationEvent = env.events.findIndex(e => e.type === 'telegram' && /sendMessage/.test(e.url));
const writeEvent = env.events.findIndex(e => e.type === 'sheet-write' && e.row === 2);
check('таблица записана и flush выполнен до Telegram', writeEvent > -1 && env.events.slice(writeEvent + 1, notificationEvent).some(e => e.type === 'flush'));

console.log('\n3) защита от дублей и проверка доставки');
const messageCount = messages(env).length;
check('повтор по ref возвращает исходный id', (r => r.ok && r.duplicate && r.id === 1)(req.post(booking)));
check('повтор имени и контактов за 15 минут отсечён', (r => r.duplicate && r.id === 1)(req.post({ ...booking, ref: 'p-test-0002' })));
check('телефоны с 8 и +7 считаются одинаковыми', req.post({ ...booking, phone: '8 918 116-45-54', contacts: '8 918 116-45-54', ref: 'p-normalized' }).duplicate === true);
check('дубль не создаёт строку и второе сообщение', sheet.getLastRow() === 2 && messages(env).length === messageCount);
check('verify подтверждает записанный ref', req.get({ action: 'verify', ref: booking.ref }).found === 1);
check('verify не подтверждает чужой ref', req.get({ action: 'verify', ref: 'нет-такого' }).found === 0);
check('ловушка для ботов игнорируется', req.post({ ...booking, ref: 'p-spam', website: 'spam' }).ignored === true);
check('ловушка не создаёт новую строку', sheet.getLastRow() === 2);

console.log('\n4) проверка обязательных данных на сервере');
const bad = createEnv(); bad.api.setup();
const badReq = requests(bad);
const invalidCases = [
  ['нет имени', { name: '' }],
  ['слишком короткое имя', { name: 'А' }],
  ['слишком длинное имя', { name: 'А'.repeat(101) }],
  ['нет контактов', { contacts: '', phone: '' }],
  ['короткий телефон', { contacts: '123', phone: '123' }],
  ['телефон длиннее 15 цифр', { contacts: '1234567890123456', phone: '1234567890123456' }],
  ['буквы в контактах', { contacts: 'позвонить 79181112233', phone: 'позвонить 79181112233' }],
  ['слишком длинная строка контактов', { contacts: '+7' + ' '.repeat(40) + '9181164554', phone: '+7' + ' '.repeat(40) + '9181164554' }],
  ['невалидный ref', { ref: '=HYPERLINK()' }],
  ['неизвестное действие', { action: 'delete' }]
];
invalidCases.forEach(([label, fields], i) => {
  check(label + ' отклонён', badReq.post({ ...booking, ref: 'p-invalid-' + i, ...fields }).ok === false);
});
check('невалидные заявки не записываются и не отправляются в Telegram', bad.sheet().getLastRow() === 1 && messages(bad).length === 0);
check('15-значный международный телефон принимается', badReq.post({ ...booking, contacts: '+123456789012345', phone: '+123456789012345', ref: 'p-international' }).ok === true);

console.log('\n5) изменения данных не теряются как «дубль», старые кэшированные поля игнорируются');
const changed = createEnv(); changed.api.setup(); const changedReq = requests(changed);
changedReq.post(booking);
check('изменённое имя — отдельная заявка', changedReq.post({ ...booking, name: 'Мария', ref: 'p-change-name' }).id === 2);
check('изменённые контакты — отдельная заявка', changedReq.post({ ...booking, contacts: '+7 918 555-66-77', phone: '+7 918 555-66-77', ref: 'p-change-phone' }).id === 3);
const oldFields = changedReq.post({
  ...booking, name: 'Пётр', ref: 'p-old-fields',
  contacts: booking.contacts, dateFrom: '2026-10-20', dateTo: '2026-10-22',
  room: 'single-1', roomLabel: 'Номер 1', docs: 'да', people: '5+', comment: 'Не хранить'
});
check('старые поля из кэшированной формы не мешают приёму', oldFields.ok === true);
check('старые лишние поля не записываются в таблицу', !changed.sheet().data.flat().some(v => v === 'Номер 1' || v === 'Не хранить'));
changed.sheet().deleteRows(oldFields.row);
check('номер заявки не переиспользуется после удаления последней строки', changedReq.post({ ...booking, contacts: '+79180001122', phone: '+79180001122', ref: 'p-after-delete' }).id === 5);

console.log('\n6) кнопки модератора, команды и ping');
const callback = (action, from = 7114829971) => ({ callback_query: {
  id: 'cb1', from: { id: from }, data: action + ':1',
  message: { message_id: 101, chat: { id: 7114829971 }, text: 'Новая заявка №1\nИмя: Анна Петрова\nКонтакты: ' + booking.contacts + '\nСтатус в таблице: Новая' }
} });
check('подтверждение обработано', req.update(callback('ok')).ok === true);
check('статус изменён в скрытой колонке', readRow(env)[col.status] === 'Подтверждена');
check('подтверждение ответа кнопки отправлено', env.fetchLog.some(f => /answerCallbackQuery/.test(f.url)));
const edited = env.fetchLog.filter(f => /editMessageText/.test(f.url)).at(-1);
check('после подтверждения данные гостя остаются в сообщении', edited.payload.text.includes('Анна Петрова') && edited.payload.text.includes(booking.contacts) && edited.payload.text.includes('Подтверждено'));
req.update(callback('no'), 'wrong-secret');
check('неверный секрет не меняет статус', readRow(env)[col.status] === 'Подтверждена');
req.update(callback('no', 999));
check('посторонний Telegram-пользователь не меняет статус', readRow(env)[col.status] === 'Подтверждена');
req.update({ message: { chat: { id: 7114829971 }, text: '/today' } });
check('/today работает с новыми колонками', messages(env).at(-1).payload.text.includes('Анна Петрова'));
req.update(callback('no'));
check('отклонение меняет статус', readRow(env)[col.status] === 'Отклонена');
check('action=status совместим и возвращает пустой объект статусов', (r => r.ok && Object.keys(r.statuses).length === 0)(req.get({ action: 'status' })));
check('ping возвращает число заявок и состояние бота', (r => r.ok && r.rows === 1 && r.telegram)(req.get({ action: 'ping' })));
check('ping сообщает актуальную схему v3 и два поля', (r => r.schemaVersion === 3 && r.fields.join('|') === 'Имя|Контакты')(req.get({ action: 'ping' })));
check('публичный ping не выдаёт токен/секрет', !JSON.stringify(req.get({ action: 'ping' })).includes('TEST-TOKEN') && !JSON.stringify(req.get({ action: 'ping' })).includes('test-webhook-secret'));

console.log('\n7) секреты в свойствах скрипта и webhook');
api.setupTelegram();
const wh = env.fetchLog.filter(f => /setWebhook/.test(f.url)).at(-1);
check('webhook использует секрет из свойств, а не публичную константу', wh.payload.url.includes('secret=test-webhook-secret'));
const freshSecret = createEnv({ properties: { WEBHOOK_SECRET: '' } });
freshSecret.api.setupTelegram();
check('при отсутствии секрета создаётся случайный UUID', /^[0-9a-f-]{36}$/i.test(freshSecret.props.get('WEBHOOK_SECRET')));
check('webhook устанавливается с новым секретом', freshSecret.fetchLog.some(f => /setWebhook/.test(f.url) && f.payload.url.includes(freshSecret.props.get('WEBHOOK_SECRET'))));
const noSecret = createEnv({ properties: { WEBHOOK_SECRET: '' } }); noSecret.api.setup(); const noSecretReq = requests(noSecret);
noSecretReq.post(booking); noSecretReq.update(callback('ok'), '');
check('пустой секрет не разрешает кнопки', readRow(noSecret)[col.status] === 'Новая');
check('вебхук можно удалить', api.removeTelegramWebhook().ok === true);

console.log('\n8) ошибки Telegram не теряют записанную заявку');
for (const [label, options] of [
  ['Telegram отклонил сообщение', { telegramSendOk: false }],
  ['сеть Telegram недоступна', { telegramThrows: true }],
  ['токен не настроен', { properties: { BOT_TOKEN: '' } }],
  ['получатель не настроен', { properties: { MODERATOR_CHAT_ID: '' } }]
]) {
  const failed = createEnv(options); failed.api.setup();
  const result = requests(failed).post(booking);
  check(label + ': запись сохранена, notified=false', result.ok && result.notified === false && failed.sheet().getLastRow() === 2);
}
const multi = createEnv({ properties: { MODERATOR_CHAT_ID: '7114829971, 123456789' } }); multi.api.setup(); requests(multi).post(booking);
check('каждый настроенный модератор получил сообщение', messages(multi).map(m => m.payload.chat_id).join(',') === '7114829971,123456789');
const tokenError = createEnv({ telegramThrowsToken: true }); tokenError.api.setup();
check('ошибка Telegram с URL не раскрывает токен через ping', !JSON.stringify(requests(tokenError).get({ action: 'ping' })).includes('TEST-TOKEN'));
const writeFail = createEnv({ failDataWrites: true }); writeFail.api.setup();
check('ошибка записи не выдаётся за успех', requests(writeFail).post(booking).ok === false && messages(writeFail).length === 0);
const lockOptions = {}; const lockFail = createEnv(lockOptions); lockFail.api.setup(); lockOptions.failLock = true;
check('без блокировки ничего не записывается', requests(lockFail).post(booking).ok === false && lockFail.sheet().getLastRow() === 1 && messages(lockFail).length === 0);

console.log('\n9) миграция предыдущего формата v2 (5 полей), с полной резервной копией');
const v2 = createEnv();
const v2Sheet = v2.ss.insertSheet('Брони');
const v2Headers = ['Имя', 'Телефон', 'Заезд/выезд', 'Номер комнаты', 'Отчётные документы', '№заявки', 'Дата заявки', 'Статус', 'Ref', 'RoomId'];
const v2Row = ['Ольга', '+79181112233', '15.10.2026 – 18.10.2026', 'Номер 4', 'Да', 7, new Date(), 'Подтверждена', 'p-v2-ref', 'family-4'];
v2Sheet.getRange(1, 1, 1, 10).setValues([v2Headers]);
v2Sheet.getRange(2, 1, 1, 10).setValues([v2Row]);
v2Sheet.getRange(2, 8, 999, 1).setDataValidation({ values: ['Новая', 'Подтверждена', 'Отклонена'], allowInvalid: false });
check('публичный ping не перестраивает старую таблицу без setup', requests(v2).get({ action: 'ping' }).ok === false && v2Sheet.getLastColumn() === 10 && archives(v2).length === 0);
v2.api.setup();
const migrated = readRow(v2);
check('новая шапка и только 6 заполненных колонок', v2Sheet.getRange(1, 1, 1, 6).getValues()[0].join('|') === api.headers.join('|') && v2Sheet.getLastColumn() === 6);
check('имя и контакты сохранены', migrated[col.name] === 'Ольга' && migrated[col.contacts] === '+79181112233');
check('id, дата, статус и ref сохранены', migrated[col.id] === 7 && migrated[col.created] instanceof Date && migrated[col.status] === 'Подтверждена' && migrated[col.ref] === 'p-v2-ref');
check('старые правила валидации очищены и перенесены в колонку Статус', v2Sheet.validations.every(v => v.col === col.status + 1));
check('полный архив старого листа создан', archives(v2).length === 1 && archives(v2)[0].getRange(1, 1, 1, 10).getValues()[0].join('|') === v2Headers.join('|'));
check('прежние даты, номер и документы сохранены в архиве', archives(v2)[0].data[1][2] === '15.10.2026 – 18.10.2026' && archives(v2)[0].data[1][3] === 'Номер 4' && archives(v2)[0].data[1][4] === 'Да');
check('старый ref по-прежнему подтверждается', requests(v2).get({ action: 'verify', ref: 'p-v2-ref' }).found === 7);
v2.api.setup();
check('повторный запуск не создаёт лишний архив', archives(v2).length === 1);
check('новая заявка после миграции получает следующий id', requests(v2).post({ ...booking, ref: 'p-after-migration' }).id === 8);

console.log('\n10) миграция более ранних форматов и отказ архива');
const legacy = createEnv(); const legacySheet = legacy.ss.insertSheet('Брони');
legacySheet.getRange(1, 1, 1, 14).setValues([['№заявки', 'Дата заявки', 'ФИО', 'Контакты', 'Заезд/выезд', 'Количество человек', 'Отч.доки', 'Номер комнаты', 'Статус', 'Ночей', 'Комментарий', 'Источник', 'Ref', 'RoomId']]);
legacySheet.getRange(2, 1, 1, 14).setValues([[9, new Date(), 'Мария', '+79181110000', '15.10.2026 – 18.10.2026', '2', 'Да', 'Номер 4', 'Подтверждена', 3, 'Сохранить в архиве', '/rooms.html', 'p-legacy', 'family-4']]);
legacy.api.setup();
check('синонимы ФИО/Контакты переносятся', readRow(legacy)[col.name] === 'Мария' && readRow(legacy)[col.contacts] === '+79181110000' && readRow(legacy)[col.id] === 9);
const noBackup = createEnv({ failBackup: true }); const untouched = noBackup.ss.insertSheet('Брони');
untouched.getRange(1, 1, 1, 10).setValues([v2Headers]); untouched.getRange(2, 1, 1, 10).setValues([v2Row]);
let backupRejected = false; try { noBackup.api.setup(); } catch { backupRejected = true; }
check('без резервной копии старый лист не изменяется', backupRejected && untouched.getRange(1, 1, 1, 10).getValues()[0].join('|') === v2Headers.join('|') && untouched.data[1][3] === 'Номер 4');

console.log('\n11) безопасность текста и размеры листа');
const escaped = createEnv(); escaped.api.setup(); const escapedReq = requests(escaped);
check('имя как формула принимается как текст', escapedReq.post({ ...booking, name: '=IMPORTXML("test")', ref: 'p-formula' }).ok === true && readRow(escaped)[col.name].startsWith("'="));
escapedReq.post({ ...booking, name: '<b>Анна & Иван</b>', ref: 'p-html' });
check('Telegram HTML из имени экранируется', messages(escaped).at(-1).payload.text.includes('&lt;b&gt;Анна &amp; Иван&lt;/b&gt;'));
const small = createEnv({ maxRows: 2, maxCols: 4 }); small.api.setup(); const smallReq = requests(small);
check('недостающие колонки создаются', small.sheet().getMaxColumns() === 6);
smallReq.post(booking);
check('при заполнении листа добавляются строки', smallReq.post({ ...booking, contacts: '+79180001133', phone: '+79180001133', ref: 'p-grow' }).ok === true && small.sheet().getMaxRows() === 3);

console.log('\nИтого: ' + pass + ' успешно, ' + fail + ' провалено\n');
process.exit(fail ? 1 : 0);
