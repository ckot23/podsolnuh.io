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

const env = createEnv();
env.api.setup();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

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
  const rows = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), 14).getValues();
  return '<table><thead><tr>' + rows[0].map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
    rows.slice(1).map(r => '<tr>' + r.map((c, i) => '<td>' +
      (c instanceof Date ? c.toLocaleString('ru-RU') : String(c === '' ? '—' : c)) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const sendJson = obj => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  // «веб-приложение Apps Script» — тот же код, что и в google-sheets/Code.gs
  if (url.pathname === '/macros/exec') {
    if (req.method === 'GET') {
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

  // в демо настройки указывают на локальную «таблицу», а не на реальный Telegram
  if (url.pathname === '/data/site.json') {
    return void sendJson({
      version: 1,
      updatedAt: new Date().toISOString(),
      statuses: {},
      cfg: { tgUrl: 'https://t.me/ckot_23', waNumber: '79882443223', phonePrimary: '+79181164554', botToken: '', chatId: '', bookingApi: '/macros/exec' }
    });
  }

  if (url.pathname === '/demo/sheet') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Демо: таблица броней</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:28px;color:#2b2b2b}
h1{font-size:20px}code{background:#fff4d6;padding:2px 6px;border-radius:6px}
table{border-collapse:collapse;margin-top:14px;font-size:13px}
th,td{border:1px solid #e3d9c3;padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#f7a93c;color:#3a2a08}tr:nth-child(even) td{background:#fffdf4}</style>
<h1>🌻 Демо-«Google-таблица» броней</h1>
<p>Это данные, которые сайт отправил на <code>/macros/exec</code> — локальный мок вместо настоящей таблицы.
Обновите страницу после отправки заявки. <a href="/rooms.html">← к странице бронирования</a></p>
${demoSheetHtml()}`);
    return;
  }

  // статика сайта
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('Не найдено: ' + rel);
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('🌻 Демо-стенд: http://localhost:' + PORT + '/rooms.html');
  console.log('   «Таблица броней»: http://localhost:' + PORT + '/demo/sheet');
  console.log('   Сообщения модератору печатаются здесь же, в консоли.');
});
