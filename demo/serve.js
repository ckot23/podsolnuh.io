/**
 * Демо-стенд: реальный сайт + НАСТОЯЩИЙ код google-sheets/Code.gs,
 * только вместо Google-таблицы и Telegram — мок-окружение (Node).
 *
 * Запуск:  node demo/serve.js   →  http://localhost:4173
 *   • кнопка «Забронировать» реально отправляет заявку в мок-таблицу;
 *   • страница /demo/sheet показывает «Google-таблицу» с заявками;
 *   • сообщение для модератора печатается в консоль сервера.
 *
 * Это ТОЛЬКО для проверки интерфейса: настоящая таблица и настоящий
 * Telegram включаются по инструкции docs/booking-google-sheets.md.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('../google-sheets/tests/mock-apps-script.js');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 4173;

// LIVE=1 — сайт отправляет заявки в НАСТОЯЩУЮ Google-таблицу (запросы идут
// из браузера гостя, поэтому sandbox-сеть не мешает). Без LIVE — мок-таблица.
const LIVE = /^(1|true|yes)$/i.test(process.env.LIVE || '');
const realSiteData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
const LIVE_API = realSiteData.cfg && realSiteData.cfg.bookingApi || '';

// метка сборки из google-sheets/Code.gs: по ней видно, обновлено ли развёртывание
const CODE_BUILD = (/var BUILD = '([^']+)'/.exec(
  fs.readFileSync(path.join(ROOT, 'google-sheets', 'Code.gs'), 'utf8')) || [])[1] || '';

const env = createEnv();
if (!LIVE) env.api.setup();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const strip = s => String(s)
  .replace(/<br\s*\/?>/g, '\n').replace(/<\/p>/g, '\n')
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function parseMultipart(body, boundary) {
  const out = {};
  body.split('--' + boundary).forEach(part => {
    const i = part.indexOf('\r\n\r\n');
    if (i === -1) return;
    const m = /name="([^"]+)"/.exec(part.slice(0, i));
    if (m) out[m[1]] = part.slice(i + 4).replace(/\r\n$/, '');
  });
  return out;
}

function demoSheetHtml() {
  const sheet = env.sheet();
  if (!sheet) return '<p>Лист ещё не создан — отправьте заявку с сайта.</p>';
  const rows = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), env.api.visibleCount).getValues();
  return '<div class="table-wrap"><table><thead><tr>' + rows[0].map(h => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.slice(1).map(r => '<tr>' + r.map((c, i) => '<td>' +
      escapeHtml(c instanceof Date ? c.toLocaleString('ru-RU') : String(c === '' ? '—' : c)) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const sendJson = obj => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  // «веб-приложение Apps Script» — тот же код, что и в google-sheets/Code.gs
  if (url.pathname === '/macros/exec' && !LIVE) {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return void res.end(env.api.doGet({ parameter: Object.fromEntries(url.searchParams.entries()) }).getContent());
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const ctype = req.headers['content-type'] || '';
      const bm = /boundary=(.+)$/.exec(ctype);
      const params = bm ? parseMultipart(body, bm[1]) : Object.fromEntries(new URLSearchParams(body).entries());
      const out = env.api.doPost({ parameter: params, postData: { contents: body, type: ctype } });
      const json = JSON.parse(out.getContent());
      if (json.ok && !json.duplicate && !json.ignored) {
        const msg = env.fetchLog.filter(f => /sendMessage/.test(f.url)).pop();
        console.log('\n📥 Заявка №' + json.id + ' записана в мок-таблицу');
        if (msg) console.log('   Сообщение модератору в Telegram:\n' +
          strip(msg.payload.text).split('\n').map(l => '   | ' + l).join('\n'));
      }
      sendJson(json);
    });
    return;
  }

  // в демо настройки указывают на локальную «таблицу», в LIVE — на настоящую
  if (url.pathname === '/data/site.json') {
    return void sendJson({
      version: 1,
      updatedAt: new Date().toISOString(),
      cfg: LIVE
        ? Object.assign({}, realSiteData.cfg)
        : { tgUrl: 'https://t.me/Olgahotel23', maxUrl: 'https://max.ru/u/f9LHodD0cOIbLwgK-CQN6QpeLWldb0OhTsbXg4qW7stL88F9IT36nmEuScw', phonePrimary: '+79181164554', bookingApi: '/macros/exec' }
    });
  }

  // самопроверка настоящего развёртывания прямо из браузера
  if (url.pathname === '/selftest') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return void res.end(selfTestPage());
  }

  if (url.pathname === '/demo/sheet' && LIVE) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return void res.end(simplePage('🌻 Режим LIVE: заявки идут в вашу таблицу',
      '<p>Этот стенд подключён к настоящему веб-приложению Apps Script, поэтому заявки с сайта ' +
      'реально попадают в Google-таблицу и в Telegram модератору.<br>Ссылку на таблицу покажет ' +
      '<a href="/selftest">самопроверка</a>.</p><p><a href="/rooms.html">← к странице бронирования</a></p>'));
  }

  if (url.pathname === '/demo/sheet') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Демо: таблица броней</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#2b2b2b}
h1{font-size:20px}code{background:#fff4d6;padding:2px 6px;border-radius:6px}
.table-wrap{overflow-x:auto}pre{white-space:pre-wrap;background:#fff4d6;padding:16px;border-radius:12px;max-width:760px}table{border-collapse:collapse;margin-top:14px;font-size:13px}
th,td{border:1px solid #e3d9c3;padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#f7a93c;color:#3a2a08}tr:nth-child(even) td{background:#fffdf4}</style>
<h1>🌻 Демо-«Google-таблица» броней</h1>
<p>Это данные, которые сайт отправил на <code>/macros/exec</code> — локальный мок вместо настоящей таблицы.
Обновите страницу после отправки заявки. <a href="/rooms.html">← к странице бронирования</a></p>
${demoSheetHtml()}
<h2>Последнее уведомление модератору (демо)</h2>
<p>Это предпросмотр сообщения бота, без отправки в настоящий Telegram.</p>
<pre>${escapeHtml(strip((env.fetchLog.filter(f => /sendMessage/.test(f.url)).at(-1) || { payload: { text: 'Пока нет заявок.' } }).payload.text))}</pre>`);
    return;
  }

  // статика сайта
  let rel;
  try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch { res.writeHead(400); return void res.end('Неверный адрес'); }
  const file = path.resolve(ROOT, '.' + rel);
  const publicFile = /^\/(index\.html|rooms\.html|sitemap\.xml|robots\.txt)$/.test(rel) ||
    /^\/(css|js|img|data|near)\//.test(rel);
  if (!publicFile || rel.split('/').some(p => p.startsWith('.')) || !file.startsWith(ROOT + path.sep) || !TYPES[path.extname(file)] || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('Не найдено: ' + rel);
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('🌻 Демо-стенд: http://localhost:' + PORT + '/rooms.html');
  if (LIVE) {
    console.log(LIVE_API ? '   РЕЖИМ LIVE: заявки уходят в ' + LIVE_API : '   ⚠️ LIVE включён, но cfg.bookingApi пуст в data/site.json');
    console.log('   Самопроверка таблицы и Telegram: http://localhost:' + PORT + '/selftest');
  } else {
    console.log('   «Таблица броней» (мок): http://localhost:' + PORT + '/demo/sheet');
    console.log('   Сообщения модератору печатаются здесь же, в консоли.');
    console.log('   Для настоящей таблицы запустите: LIVE=1 node demo/serve.js');
  }
});

function simplePage(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#2b2b2b;max-width:820px}
h1{font-size:20px}a{color:#c1740a}code{background:#fff4d6;padding:2px 6px;border-radius:6px;word-break:break-all}</style>
<h1>${title}</h1>${body}`;
}

/** Страница самопроверки: пингует настоящее развёртывание и умеет отправить тестовую заявку. */
function selfTestPage() {
  const activeApi = LIVE ? LIVE_API : '/macros/exec';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проверка таблицы броней</title>
<style>
body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;padding:26px;color:#2b2b2b;max-width:880px;margin:0 auto}
h1{font-size:21px;margin:0 0 4px} p{margin:8px 0}
code{background:#fff4d6;padding:2px 6px;border-radius:6px;word-break:break-all}
button{font:600 15px inherit;padding:11px 18px;margin:6px 8px 6px 0;border:0;border-radius:12px;cursor:pointer;
  background:linear-gradient(135deg,#ffd33a,#f29f17);color:#3a2a08}
button.secondary{background:#fff;border:1.5px solid #e3d9c3;color:#2b2b2b}
button:disabled{opacity:.55;cursor:default}
pre{background:#1f2933;color:#d7e3ee;padding:14px;border-radius:12px;overflow:auto;font-size:12.5px;white-space:pre-wrap}
.ok{color:#2f6b23;font-weight:700}.bad{color:#b4362b;font-weight:700}.warn{color:#a06200;font-weight:700}
a{color:#c1740a}
</style>
<h1>🌻 Проверка Google-таблицы броней</h1>
<p>Таблица: <code id="api">${escapeHtml(activeApi || '(не указана в data/site.json)')}</code></p>
<p>Запросы идут прямо из вашего браузера — так же, как с сайта у гостя.</p>
<p>
  <button id="ping">1. Проверить связь</button>
  <button id="book" class="secondary">2. Отправить тестовую заявку</button>
</p>
<div id="out"><p class="warn">Начните с проверки связи.</p></div>
<script>
var API = ${JSON.stringify(activeApi)};
var EXPECTED_BUILD = ${JSON.stringify(CODE_BUILD)};
var out = document.getElementById('out');
function show(html, json){ out.innerHTML = html + (json ? '<pre>' + JSON.stringify(json, null, 2) + '</pre>' : ''); }
function busy(btn, on, text){ btn.disabled = on; if(text) btn.textContent = text; }
function badge(ok, yes, no){ return ok ? '<span class="ok">' + yes + '</span>' : '<span class="bad">' + no + '</span>'; }

document.getElementById('ping').onclick = function(){
  var b = this; busy(b, true, 'Проверяем…');
  fetch(API + '?action=ping&t=' + Date.now()).then(function(r){ return r.json(); }).then(function(j){
    busy(b, false, '1. Проверить связь');
    if(!j.ok){ show('<p class="bad">Ошибка: ' + (j.error || 'нет ответа') + '</p>', j); return; }
    var buildOk = j.build && j.build === EXPECTED_BUILD;
    var last = j.lastNotify
      ? (j.lastNotify.ok ? badge(true, 'успешно', '') : badge(false, 'ОШИБКА: ' + j.lastNotify.error, ''))
      : 'ещё не было отправок';
    show('<p>Таблица: <b>' + j.sheet + '</b> — ' + badge(true, 'доступна', '') + '<br>' +
      'Заявок в таблице: <b>' + j.rows + '</b><br>' +
      'Ссылка: <a href="' + j.sheetUrl + '" target="_blank" rel="noopener">открыть таблицу</a><br>' +
      'Telegram: ' + (j.bot ? '<b>' + j.bot + '</b>' : badge(j.telegram, 'бот на связи', 'нет связи с ботом')) +
      (j.chatIdsSet === false ? ' · ' + badge(false, 'chat_id не задан', '') : '') + '<br>' +
      'Развёрнутый код: <b>' + (j.build || 'не известно') + '</b> ' +
      (j.build ? (buildOk ? badge(true, 'актуальный', '') : badge(false, 'УСТАРЕЛ — нужен «Новая версия» в развёртывании', '')) : '') + '<br>' +
      'Последняя доставка в Telegram: ' + last + '<br>' +
      'Недоставленных в очереди: <b>' + (j.pending || 0) + '</b></p>', j);
  }).catch(function(e){
    busy(b, false, '1. Проверить связь');
    show('<p class="bad">Браузер не смог обратиться к таблице: ' + e.message + '</p>' +
      '<p>Проверьте, что у веб-приложения доступ «Все» и что ссылка скопирована целиком (заканчивается на /exec).</p>');
  });
};

document.getElementById('book').onclick = function(){
  var b = this;
  if(!confirm(${JSON.stringify('Тестовая заявка попадёт в ')} + ${JSON.stringify(LIVE ? 'настоящую таблицу и Telegram модератора' : 'локальную демо-таблицу')} + '. Продолжить?')) return;
  var ref = 'p-browser-' + Date.now();
  var fd = new URLSearchParams();
  [['action', 'book'], ['name', 'Проверка сайта (тест)'], ['phone', '+7 918 116-45-54'], ['ref', ref]]
    .forEach(function(p){ fd.append(p[0], p[1]); });
  busy(b, true, 'Отправляем…');
  fetch(API, { method: 'POST', body: fd }).then(function(r){ return r.text(); }).then(function(t){
    var j = null; try { j = JSON.parse(t); } catch(e){}
    busy(b, false, '2. Отправить тестовую заявку');
    if(!j){ show('<p class="warn">Ответ не разобрался, но заявка могла записаться. Проверьте таблицу и Telegram.</p><pre>' + t.slice(0,500) + '</pre>'); return; }
    if(j.ok && j.duplicate) show('<p class="warn">Такая заявка уже есть — №' + j.id + ' (защита от дублей работает).</p>', j);
    else if(j.ok) show('<p>' + badge(true, 'Заявка №' + j.id + ' принята', '') + '<br>Записана в таблицу: ' + badge(true, 'да', '?') + '<br>' +
      'Сообщение модератору в Telegram: ' +
      (j.notified ? badge(true, 'отправлено', '')
                  : badge(false, 'НЕ отправлено' + (j.notifyError ? ' — ' + j.notifyError : ''), '')) + '</p>' +
      '<p>' + (j.notified
        ? 'Проверьте Telegram и таблицу. Строку с тестом и сообщение можно удалить.'
        : 'Заявка в таблице есть, но бот не смог написать. Причина выше; подробный разбор — функция <code>diagnose()</code> в редакторе Apps Script.') + '</p>', j);
    else show('<p class="bad">Ошибка: ' + (j.error || 'неизвестно') + '</p>', j);
  }).catch(function(e){
    busy(b, false, '2. Отправить тестовую заявку');
    show('<p class="bad">Не удалось отправить: ' + e.message + '</p><p>Если заявка всё же появилась в таблице — приём работает, мешает только ответ браузеру.</p>');
  });
};
</script>`;
}
