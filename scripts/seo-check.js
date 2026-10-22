/**
 * Быстрая проверка SEO-разметки (только Node.js, без зависимостей).
 * Запуск: node scripts/seo-check.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let fail = 0;
const ok = (n, c, x) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && x ? ' → ' + x : '')); if (!c) fail++; };

const pages = { 'index.html': 'https://podsolnuh.io/', 'rooms.html': 'https://podsolnuh.io/rooms.html' };
for (const [file, url] of Object.entries(pages)) {
  console.log(file);
  const h = fs.readFileSync(path.join(root, file), 'utf8');
  const title = (h.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const desc = (h.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '';
  ok('title 20–80 символов', title.length >= 20 && title.length <= 80, title.length);
  ok('description 70–200 символов', desc.length >= 70 && desc.length <= 200, desc.length);
  ok('canonical = ' + url, h.includes('<link rel="canonical" href="' + url + '"'));
  ok('og:url = ' + url, h.includes('<meta property="og:url" content="' + url + '"'));
  ok('ровно один <h1>', (h.match(/<h1[\s>]/g) || []).length === 1);
  ok('у всех <img> есть alt', !/<img(?![^>]*\balt=)[^>]*>/.test(h));
  const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  ok('есть JSON-LD', blocks.length > 0);
  blocks.forEach((b, i) => { try { JSON.parse(b[1]); ok('JSON-LD #' + (i + 1) + ' валиден', true); } catch (e) { ok('JSON-LD #' + (i + 1) + ' валиден', false, e.message); } });
  // локальные ссылки на файлы
  const refs = [...h.matchAll(/(?:src|href|srcset)="((?:img|css|js|data)\/[^"?#]+)/g)].map(m => m[1]);
  const missing = [...new Set(refs)].filter(f => !fs.existsSync(path.join(root, f)));
  ok('локальные ресурсы существуют', missing.length === 0, missing.join(', '));
}
console.log('index.html — FAQ');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const faqLd = [...idx.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1])).find(j => j['@type'] === 'FAQPage');
const visible = (idx.match(/<details class="faq-item/g) || []).length;
ok('вопросы в разметке FAQPage совпадают с видимыми', faqLd && faqLd.mainEntity.length === visible, visible);

console.log('sitemap.xml / robots.txt');
const sm = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
ok('sitemap содержит обе страницы', Object.values(pages).every(u => sm.includes('<loc>' + u + '</loc>')));
const imgs = [...sm.matchAll(/<image:loc>https:\/\/podsolnuh\.io\/([^<]+)<\/image:loc>/g)].map(m => m[1]);
ok('картинки из sitemap существуют', imgs.every(f => fs.existsSync(path.join(root, f))));
ok('robots.txt ссылается на sitemap', /Sitemap: https:\/\/podsolnuh\.io\/sitemap\.xml/.test(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8')));
console.log(fail ? '\nОшибок: ' + fail : '\nВсё в порядке');
process.exit(fail ? 1 : 0);
