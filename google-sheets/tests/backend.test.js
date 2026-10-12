/**
 * Автопроверка приёма заявки, новой таблицы, миграции и Telegram без Google-аккаунта.
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
    multipart: params => JSON.parse(env.api.doPost({ parameter: params, postData: { contents: '------boundary\r\nContent-Disposition…', type: 'multipart/form-data; boundary=----boundary' } }).getContent()),
    update: (update, secret = env.props.get('WEBHOOK_SECRET')) => JSON.parse(env.api.doPost({ parameter: { secret }, postData: { contents: JSON.stringify(update) } }).getContent()),
    get: params => JSON.parse(env.api.doGet({ parameter: params }).getContent())
  };
}
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const after = n => new Date(new Date(day + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const booking = {
  action: 'book', name: 'Анна Петрова', phone: '+7 918 116-45-54',
  dateFrom: day, dateTo: after(2), room: 'single-1', docs: 'да', ref: 'p-test-0001'
};
const messages = env => env.fetchLog.filter(f => /sendMessage/.test(f.url));
const archives = env => env.ss.sheets.filter(s => / — архив /.test(s.name));
const readRow = (env, row = 2) => env.sheet().getRange(row, 1, 1, env.api.headers.length).getValues()[0];

console.log('\n1) setup — только пять видимых полей');
const env = createEnv();
const api = env.api, req = requests(env), col = api.columns;
api.setup();
const sheet = env.sheet();
check('лист «Брони» создан', !!sheet);
check('видны только имя, телефон, даты, номер, документы', sheet.getRange(1, 1, 1, 5).getValues()[0].join('|') === 'Имя|Телефон|Заезд/выезд|Номер комнаты|Отчётные документы');
check('служебные колонки не содержат гостей/комментарий/источник', api.headers.slice(5).join('|') === '№заявки|Дата заявки|Статус|Ref|RoomId');
check('все служебные колонки скрыты', [6, 7, 8, 9, 10].every(c => sheet.hiddenCols.includes(c)) && [1, 2, 3, 4, 5].every(c => !sheet.hiddenCols.includes(c)));
check('правило статусов стоит в новой колонке', sheet.validations.length === 1 && sheet.validations[0].col === col.status + 1);
check('телефон имеет текстовый формат', sheet.formats.some(f => f.col <= col.phone + 1 && f.col + f.numCols > col.phone + 1 && f.format === '@'));
check('реальный id таблицы сохранён для веб-приложения', env.props.get('SHEET_ID') === 'TESTID');
check('повторный setup не создаёт архив текущего формата', (api.setup(), archives(env).length === 0));

console.log('\n2) минимальная заявка с сайта, без гостей и комментария');
const res = req.multipart(booking);
check('multipart принят и записан', res.ok === true && res.id === 1, JSON.stringify(res));
check('ночи рассчитаны на сервере', res.nights === 2);
check('уведомление отправлено', res.notified === true);
const row = readRow(env);
check('имя сохранено', row[col.name] === booking.name);
check('телефон сохранён без потери плюса', row[col.phone] === booking.phone);
check('обе даты в одной колонке', /^\d{2}\.\d{2}\.\d{4} – \d{2}\.\d{2}\.\d{4}$/.test(row[col.dates]));
check('номер взят из серверного справочника', row[col.room] === 'Номер 1');
check('галочка документов сохранена как «Да»', row[col.docs] === 'Да');
check('служебный id, дата и статус сохранены', row[col.id] === 1 && row[col.created] instanceof Date && row[col.status] === 'Новая');
check('ref и внутренний id комнаты сохранены', row[col.ref] === booking.ref && row[col.roomId] === 'single-1');
check('нет лишних колонок и значений', sheet.getLastColumn() === 10 && row.length === 10);
const tg = messages(env).at(-1);
check('заголовок «Новая заявка»', tg.payload.text.includes('Новая заявка №1'));
check('в Telegram все пять полей', ['Анна Петрова', booking.phone, row[col.dates], 'Номер 1', 'Отчётные документы:</b> Да'].every(t => tg.payload.text.includes(t)));
check('в Telegram нет старых полей', !/Количество человек|Комментарий|Источник/.test(tg.payload.text));
check('сообщение отправлено настроенному модератору', tg.payload.chat_id === '7114829971');
check('кнопки модерации и таблицы сохранены', ['ok:1', 'no:1', 'TESTID'].every(t => tg.payload.reply_markup.includes(t)));
const notificationEvent = env.events.findIndex(e => e.type === 'telegram' && /sendMessage/.test(e.url));
const writeEvent = env.events.findIndex(e => e.type === 'sheet-write' && e.row === 2);
check('таблица записана и flush выполнен до Telegram', writeEvent > -1 && env.events.slice(writeEvent + 1, notificationEvent).some(e => e.type === 'flush'));

console.log('\n3) защита от дублей и проверка доставки');
const messageCount = messages(env).length;
check('повтор по ref возвращает исходный id', (r => r.ok && r.duplicate && r.id === 1)(req.post(booking)));
check('повтор всех полей за 15 минут отсечён', (r => r.duplicate && r.id === 1)(req.post({ ...booking, ref: 'p-test-0002' })));
check('телефоны с 8 и +7 считаются одинаковыми', req.post({ ...booking, phone: '8 918 116-45-54', ref: 'p-normalized' }).duplicate === true);
check('дубль не создаёт строку и второе сообщение', sheet.getLastRow() === 2 && messages(env).length === messageCount);
check('verify подтверждает записанный ref', req.get({ action: 'verify', ref: booking.ref }).found === 1);
check('verify не подтверждает чужой ref', req.get({ action: 'verify', ref: 'нет-такого' }).found === 0);
check('ловушка для ботов игнорируется', req.post({ ...booking, ref: 'p-spam', website: 'spam' }).ignored === true);
check('ловушка не создаёт новую строку', sheet.getLastRow() === 2);

console.log('\n4) проверка всех обязательных данных на сервере');
const bad = createEnv(); bad.api.setup();
const badReq = requests(bad);
const invalidCases = [
  ['нет имени', { name: '' }], ['слишком короткое имя', { name: 'А' }], ['слишком длинное имя', { name: 'А'.repeat(101) }],
  ['короткий телефон', { phone: '123' }], ['телефон длиннее 15 цифр', { phone: '1234567890123456' }],
  ['буквы в телефоне', { phone: 'позвонить 79181112233' }], ['слишком длинная строка телефона', { phone: '+7' + ' '.repeat(40) + '9181164554' }],
  ['нет дат', { dateFrom: '', dateTo: '' }], ['нет выезда', { dateTo: '' }], ['выезд равен заезду', { dateTo: day }],
  ['выезд раньше заезда', { dateTo: after(-1) }], ['несуществующий день месяца', { dateFrom: '2026-02-30' }],
  ['недопустимая ISO-дата не заменяется человеческой', { dateFrom: '2026-02-30', dates: '01.03.2026 – 04.03.2026' }],
  ['нет номера', { room: '' }], ['неизвестный номер', { room: 'not-a-room' }],
  ['невалидный ref', { ref: '=HYPERLINK()' }], ['неизвестное действие', { action: 'delete' }]
];
invalidCases.forEach(([label, fields], i) => {
  check(label + ' отклонён', badReq.post({ ...booking, ref: 'p-invalid-' + i, ...fields }).ok === false);
});
check('невалидные заявки не записываются и не отправляются в Telegram', bad.sheet().getLastRow() === 1 && messages(bad).length === 0);
check('15-значный международный телефон принимается', badReq.post({ ...booking, phone: '+123456789012345', ref: 'p-international' }).ok === true);

console.log('\n5) изменения данных не теряются как «дубль»');
const changed = createEnv(); changed.api.setup(); const changedReq = requests(changed);
changedReq.post(booking);
check('изменённая галочка — отдельная заявка', changedReq.post({ ...booking, docs: 'нет', ref: 'p-change-docs' }).id === 2);
check('без галочки в таблице «Нет»', readRow(changed, 3)[col.docs] === 'Нет');
check('изменённый выезд — отдельная заявка', changedReq.post({ ...booking, dateTo: after(3), ref: 'p-change-date' }).id === 3);
check('изменённый номер — отдельная заявка', changedReq.post({ ...booking, room: 'studio-4', ref: 'p-change-room' }).id === 4);
check('изменённое имя — отдельная заявка', changedReq.post({ ...booking, name: 'Мария', ref: 'p-change-name' }).id === 5);
const oldFields = changedReq.post({ ...booking, name: 'Пётр', ref: 'p-old-fields', contacts: booking.phone, people: '5+', guests: '5+', comment: 'Не хранить', page: '/rooms.html', roomLabel: 'Подменённый номер' });
check('старые поля из кэшированной формы не мешают приёму', oldFields.ok === true);
check('старые лишние поля игнорируются, номер не подменяется', readRow(changed, oldFields.row)[col.room] === 'Номер 1' && !changed.sheet().data.flat().includes('Не хранить'));
changed.sheet().deleteRows(oldFields.row);
check('номер заявки не переиспользуется после удаления последней строки', changedReq.post({ ...booking, phone: '+79180001122', ref: 'p-after-delete' }).id === 7);

console.log('\n6) кнопки модератора, команды и статусы номеров');
const callback = (action, from = 7114829971) => ({ callback_query: {
  id: 'cb1', from: { id: from }, data: action + ':1',
  message: { message_id: 101, chat: { id: 7114829971 }, text: 'Новая заявка №1\nИмя: Анна Петрова\nТелефон: ' + booking.phone + '\nСтатус в таблице: Новая' }
} });
check('подтверждение обработано', req.update(callback('ok')).ok === true);
check('статус изменён в новой скрытой колонке', readRow(env)[col.status] === 'Подтверждена');
check('подтверждение ответа кнопки отправлено', env.fetchLog.some(f => /answerCallbackQuery/.test(f.url)));
const edited = env.fetchLog.filter(f => /editMessageText/.test(f.url)).at(-1);
check('после подтверждения данные гостя остаются в сообщении', edited.payload.text.includes('Анна Петрова') && edited.payload.text.includes(booking.phone) && edited.payload.text.includes('Подтверждено'));
req.update(callback('no'), 'wrong-secret');
check('неверный секрет не меняет статус', readRow(env)[col.status] === 'Подтверждена');
req.update(callback('no', 999));
check('посторонний Telegram-пользователь не меняет статус', readRow(env)[col.status] === 'Подтверждена');
check('сайт видит подтверждённую бронь на сегодня', req.get({ action: 'status' }).statuses['single-1'] === 'busy');
check('неподтверждённые номера не заняты', Object.keys(req.get({ action: 'status' }).statuses).length === 1);
req.update({ message: { chat: { id: 7114829971 }, text: '/today' } });
check('/today работает с новыми колонками', messages(env).at(-1).payload.text.includes('Анна Петрова'));
req.update(callback('no'));
check('отклонение меняет статус', readRow(env)[col.status] === 'Отклонена');
check('отклонённая бронь освобождает номер', !req.get({ action: 'status' }).statuses['single-1']);
check('ping возвращает число заявок и состояние бота', (r => r.ok && r.rows === 1 && r.telegram)(req.get({ action: 'ping' })));
check('ping сообщает актуальную схему и пять полей', (r => r.schemaVersion === 2 && r.fields.length === 5)(req.get({ action: 'ping' })));
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

console.log('\n9) миграция предыдущего формата, с полной резервной копией');
const old = createEnv();
const oldSheet = old.ss.insertSheet('Брони');
const oldHeaders = ['№заявки', 'Дата заявки', 'Имя', 'Контакты', 'Заезд/выезд', 'Количество человек', 'Отч.доки', 'Номер комнаты', 'Статус', 'Ночей', 'Комментарий', 'Источник', 'Ref', 'RoomId'];
const oldRow = [7, new Date(), 'Ольга', '+79181112233', '15.10.2026 – 18.10.2026', '3', 'Да', 'Номер 4', 'Подтверждена', 3, 'Сохранить в архиве', '/rooms.html', 'p-old-ref', 'family-4'];
oldSheet.getRange(1, 1, 1, 14).setValues([oldHeaders]);
oldSheet.getRange(2, 1, 1, 14).setValues([oldRow]);
oldSheet.getRange(2, 9, 999, 1).setDataValidation({ values: ['Новая', 'Подтверждена', 'Отклонена'], allowInvalid: false });
check('публичный ping не перестраивает старую таблицу без setup', requests(old).get({ action: 'ping' }).ok === false && oldSheet.getLastColumn() === 14 && archives(old).length === 0);
old.api.setup();
const migrated = readRow(old);
check('новая шапка и только 10 заполненных колонок', oldSheet.getRange(1, 1, 1, 10).getValues()[0].join('|') === api.headers.join('|') && oldSheet.getLastColumn() === 10);
check('все пять полей сохранены', migrated[col.name] === 'Ольга' && migrated[col.phone] === '+79181112233' && migrated[col.dates] === oldRow[4] && migrated[col.room] === 'Номер 4' && migrated[col.docs] === 'Да');
check('id, дата, статус, ref, roomId сохранены', migrated[col.id] === 7 && migrated[col.created] instanceof Date && migrated[col.status] === 'Подтверждена' && migrated[col.ref] === 'p-old-ref' && migrated[col.roomId] === 'family-4');
check('старые правила в колонке Ref удалены', oldSheet.validations.every(v => v.col === col.status + 1));
check('полный архив старого листа создан', archives(old).length === 1 && archives(old)[0].getRange(1, 1, 1, 14).getValues()[0].join('|') === oldHeaders.join('|'));
check('гости и комментарии не потеряны — остаются в архиве', archives(old)[0].data[1][5] === '3' && archives(old)[0].data[1][10] === 'Сохранить в архиве');
check('старый ref по-прежнему подтверждается', requests(old).get({ action: 'verify', ref: 'p-old-ref' }).found === 7);
old.api.setup();
check('повторный запуск не создаёт лишний архив', archives(old).length === 1);
check('новая заявка после миграции получает следующий id', requests(old).post({ ...booking, ref: 'p-after-migration' }).id === 8);

console.log('\n10) миграция более старого формата и отказ архива');
const legacy = createEnv(); const legacySheet = legacy.ss.insertSheet('Брони');
legacySheet.getRange(1, 1, 1, 11).setValues([['Дата заявки', 'ФИО', 'Телефон', 'Заезд', 'Выезд', 'Гостей', 'Документы', '№', 'Статус', 'Ночей', 'Номер']]);
legacySheet.getRange(2, 1, 1, 11).setValues([[new Date(), 'Мария', '+79181110000', new Date(2026, 9, 15, 12), new Date(2026, 9, 18, 12), '2', 'Да', 9, 'Подтверждена', 3, 'Номер 4']]);
legacy.api.setup();
check('синонимы имени/телефона/документов переносятся', readRow(legacy)[col.name] === 'Мария' && readRow(legacy)[col.phone] === '+79181110000' && readRow(legacy)[col.docs] === 'Да');
check('заезд и выезд склеиваются', readRow(legacy)[col.dates] === '15.10.2026 – 18.10.2026');
check('RoomId восстанавливается по номеру для статусов', readRow(legacy)[col.roomId] === 'family-4');
const noBackup = createEnv({ failBackup: true }); const untouched = noBackup.ss.insertSheet('Брони');
untouched.getRange(1, 1, 1, 14).setValues([oldHeaders]); untouched.getRange(2, 1, 1, 14).setValues([oldRow]);
let backupRejected = false; try { noBackup.api.setup(); } catch { backupRejected = true; }
check('без резервной копии старый лист не изменяется', backupRejected && untouched.getRange(1, 1, 1, 14).getValues()[0].join('|') === oldHeaders.join('|') && untouched.data[1][10] === 'Сохранить в архиве');

console.log('\n11) даты, безопасность текста и размеры листа');
check('даты без года читаются', api.parseDates_({ dates: '12.10 – 15.10 (3 сут.)' }).nights === 3);
check('переход через год читается', (r => r.fromIso === '2026-12-28' && r.toIso === '2027-01-02' && r.nights === 5)(api.parseDates_({ dates: '28.12.2026 – 02.01.2027 (5 сут.)' })));
check('ISO-даты имеют приоритет и в сообщении', (r => r.pair === '01.03.2026 – 04.03.2026' && r.human === r.pair)(api.parseDates_({ dates: 'неправильная строка', dateFrom: '2026-03-01', dateTo: '2026-03-04' })));
check('невозможная человеческая дата не нормализуется молча', !api.parseDates_({ dates: '30.02.2026 – 04.03.2026' }).from);
const escaped = createEnv(); escaped.api.setup(); const escapedReq = requests(escaped);
check('имя как формула принимается как текст', escapedReq.post({ ...booking, name: '=IMPORTXML("test")', ref: 'p-formula' }).ok === true && readRow(escaped)[col.name].startsWith("'="));
escapedReq.post({ ...booking, name: '<b>Анна & Иван</b>', ref: 'p-html' });
check('Telegram HTML из имени экранируется', messages(escaped).at(-1).payload.text.includes('&lt;b&gt;Анна &amp; Иван&lt;/b&gt;'));
const small = createEnv({ maxRows: 2, maxCols: 8 }); small.api.setup(); const smallReq = requests(small);
check('недостающие колонки создаются', small.sheet().getMaxColumns() === 10);
smallReq.post(booking);
check('при заполнении листа добавляются строки', smallReq.post({ ...booking, phone: '+79180001133', ref: 'p-grow' }).ok === true && small.sheet().getMaxRows() === 3);

console.log('\nИтого: ' + pass + ' успешно, ' + fail + ' провалено\n');
process.exit(fail ? 1 : 0);
