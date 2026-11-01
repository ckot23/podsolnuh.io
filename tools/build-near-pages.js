#!/usr/bin/env node
/**
 * Генератор страниц блока «Рядом с «Подсолнухом»».
 *
 *   node tools/build-near-pages.js
 *
 * Читает data/near-places.json, картинки из img/near/ и собирает
 * статические страницы near/<slug>.html + sitemap.xml.
 *
 * Страницы статические (контент и SEO-мета в HTML), поэтому их видят
 * поисковые роботы без выполнения JavaScript. Меняете текст или фото —
 * правьте data/near-places.json (или img/near/) и запускайте скрипт снова.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'near');
const SITE = 'https://podsolnuh.io';
const CSS_VERSION = '20261031-near-1';
const JS_VERSION = '20261031-near-1';

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'near-places.json'), 'utf8'));
const hotel = data.hotel;

/* ---------- утилиты ---------- */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Размер JPEG из SOF-маркера — нужен для width/height (нет скачков вёрстки). */
function jpegSize(file) {
  const buf = fs.readFileSync(file);
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: 1600, height: 1067 };
}

const sizeCache = new Map();
function image(file) {
  const jpg = path.join(ROOT, 'img', 'near', file + '.jpg');
  const webp = path.join(ROOT, 'img', 'near', file + '.webp');
  if (!fs.existsSync(jpg)) throw new Error('Нет файла img/near/' + file + '.jpg');
  if (!sizeCache.has(file)) sizeCache.set(file, jpegSize(jpg));
  return {
    jpg: '../img/near/' + file + '.jpg',
    webp: fs.existsSync(webp) ? '../img/near/' + file + '.webp' : '',
    width: sizeCache.get(file).width,
    height: sizeCache.get(file).height
  };
}

/* ---------- общие блоки ---------- */

function head(p) {
  const url = SITE + '/near/' + p.slug + '.html';
  const ogImage = SITE + '/img/near/' + p.heroImage + '.jpg';
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Рядом с «Подсолнухом»', item: SITE + '/#near' },
      { '@type': 'ListItem', position: 3, name: p.cardTitle, item: url }
    ]
  };
  const entity = isPlace(p) ? {
    '@context': 'https://schema.org',
    '@type': p.entityType || 'TouristAttraction',
    name: p.entityName,
    description: p.seoDescription,
    url: url,
    image: p.gallery.map(g => SITE + '/img/near/' + g.file + '.jpg'),
    address: {
      '@type': 'PostalAddress',
      streetAddress: p.entityStreet || undefined,
      addressLocality: 'Краснодар',
      addressRegion: 'Краснодарский край',
      addressCountry: 'RU'
    },
    touristType: p.touristType,
    ...(p.entityType === 'StadiumOrArena' ? {} : { isAccessibleForFree: true, publicAccess: true })
  } : {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: p.seoTitle,
    description: p.seoDescription,
    url: url,
    about: {
      '@type': 'Hotel',
      name: hotel.name,
      telephone: '+7-918-116-45-54',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'ул. Цветочная, 162',
        addressLocality: 'Краснодар',
        addressCountry: 'RU'
      }
    }
  };

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(p.seoTitle)}</title>
<meta name="description" content="${esc(p.seoDescription)}" />
<meta name="theme-color" content="#ad805c" />
<meta name="color-scheme" content="light" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<script>
/* Анимации появления включаем только при работающем JS. */
(function () {
  var d = document.documentElement;
  d.classList.add('has-js');
  setTimeout(function () { if (!d.classList.contains('anim-ready')) d.classList.remove('has-js'); }, 2500);
})();
</script>
<meta property="og:type" content="article" />
<meta property="og:locale" content="ru_RU" />
<meta property="og:site_name" content="Гостиница «Подсолнух», Краснодар" />
<meta property="og:title" content="${esc(p.seoTitle)}" />
<meta property="og:description" content="${esc(p.seoDescription)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:image:alt" content="${esc(p.heroAlt)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(p.seoTitle)}" />
<meta name="twitter:description" content="${esc(p.seoDescription)}" />
<meta name="twitter:image" content="${ogImage}" />
<link rel="canonical" href="${url}" />
<link rel="icon" href="../img/favicon.png" type="image/png" sizes="128x128" />
<link rel="stylesheet" href="../css/site.css?v=${CSS_VERSION}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;800;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<script type="application/ld+json">
${JSON.stringify(crumbs, null, 2)}
</script>
<script type="application/ld+json">
${JSON.stringify(entity, null, 2)}
</script>
</head>`;
}

function isPlace(p) {
  return p.type !== 'service';
}

function header() {
  return `<body>
<noscript><div class="noscript-notice">Чтобы оставить онлайн-заявку, включите JavaScript. Или позвоните: <a href="tel:${hotel.phone}">${hotel.phoneHuman}</a>.</div></noscript>

<div class="deco-layer" id="decoLayer" aria-hidden="true"></div>

<a class="skip-link" href="#main">Перейти к содержимому</a>

<header id="header">
  <div class="wrap top">
    <a class="logo" href="../index.html" aria-label="Гостиница Подсолнух — на главную">
      <img class="logo-flower" src="../img/sunflower.webp" alt="" aria-hidden="true" width="52" height="52" />
      <span class="logo-text">
        <strong>Подсолнух</strong>
        <span>Гостиница · Краснодар</span>
      </span>
    </a>
    <nav aria-label="Основная навигация">
      <ul>
        <li><a href="../index.html#our-rooms">Наши номера</a></li>
        <li><a href="../rooms.html">Бронирование</a></li>
        <li><a href="../index.html#benefits">Почему мы</a></li>
        <li><a href="../index.html#near" aria-current="page">Рядом</a></li>
        <li><a href="../index.html#faq">Вопросы</a></li>
        <li><a href="../index.html#contacts">Контакты</a></li>
      </ul>
    </nav>
    <div class="top-contacts">
      <a class="top-phone" href="tel:${hotel.phone}">${hotel.phoneHuman}<small>бронирование</small></a>
      <a class="btn max small header-max-btn" data-max href="${hotel.max}" target="_blank" rel="noopener noreferrer">MAX</a>
      <a class="btn primary small header-book-btn" href="../rooms.html">Забронировать</a>
    </div>
  </div>
</header>

<main id="main">
<div class="wrap" id="top">`;
}

function crumbs(p) {
  return `  <nav class="crumbs" aria-label="Хлебные крошки">
    <ol>
      <li><a href="../index.html">Главная</a></li>
      <li><a href="../index.html#near">Рядом с «Подсолнухом»</a></li>
      <li aria-current="page">${esc(p.cardTitle)}</li>
    </ol>
  </nav>`;
}

function hero(p) {
  const img = image(p.heroImage);
  return `  <section class="place-hero" aria-labelledby="placeTitle">
    <div class="place-hero-media reveal">
      <picture>
        <source srcset="${img.webp}" type="image/webp" />
        <img src="${img.jpg}" alt="${esc(p.heroAlt)}" width="${img.width}" height="${img.height}" fetchpriority="high" decoding="async" />
      </picture>
      <p class="place-dist">${esc(p.dist)} <span>от гостиницы</span></p>
    </div>
    <div class="place-hero-copy reveal d1">
      <p class="kicker"><span class="dot"></span>${esc(p.kicker)}</p>
      <h1 id="placeTitle">${esc(p.h1)}</h1>
      <p class="lead">${esc(p.lead)}</p>
      <ul class="place-highlights">
${p.highlights.map(h => `        <li>${esc(h)}</li>`).join('\n')}
      </ul>
      <div class="cta-row">
        <a class="btn primary" href="../rooms.html">Забронировать</a>
        <a class="btn ghost" href="tel:${hotel.phone}">${hotel.phoneHuman}</a>
      </div>
    </div>
  </section>`;
}

function intro(p) {
  return `  <section class="place-about" aria-labelledby="aboutTitle">
    <div class="place-about-copy reveal">
      <h2 id="aboutTitle">${isPlace(p) ? 'Как добраться и почему это удобно' : 'Как это работает'}</h2>
${p.intro.map(t => `      <p>${esc(t)}</p>`).join('\n')}
    </div>
    <aside class="place-facts reveal d1" aria-label="Коротко о проживании">
      <h2 class="place-facts-title">Коротко</h2>
      <dl>
${p.facts.map(f => `        <div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('\n')}
      </dl>
      <p class="place-facts-note">${esc(hotel.name)}, ${esc(hotel.address)}</p>
    </aside>
  </section>`;
}

function gallery(p) {
  const items = p.gallery.map((g, i) => {
    const img = image(g.file);
    return `      <figure class="place-photo reveal${i % 3 ? ' d' + (i % 3) : ''}" data-gallery-item data-full="${img.jpg}" data-webp="${img.webp}" data-alt="${esc(g.alt)}">
        <picture>
          <source srcset="${img.webp}" type="image/webp" />
          <img src="${img.jpg}" alt="${esc(g.alt)}" width="${img.width}" height="${img.height}" loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async" />
        </picture>
        <figcaption>${esc(g.alt)}</figcaption>
      </figure>`;
  }).join('\n');

  return `  <section class="place-gallery-sec" aria-labelledby="galleryTitle">
    <div class="sec-head reveal">
      <p class="sec-kicker">🌻 Фотографии</p>
      <h2 id="galleryTitle">${isPlace(p) ? 'Фото: ' + esc(p.cardTitle) : 'Фото номеров и двора'}</h2>
      <p class="sec-sub">Нажмите на снимок, чтобы открыть его крупнее.</p>
    </div>
    <div class="place-gallery">
${items}
    </div>
  </section>`;
}

function mapBlock(p) {
  if (!isPlace(p)) return '';
  const q = encodeURIComponent(p.mapQuery || 'Краснодар, ' + hotel.address);
  return `  <section class="place-map-sec" aria-labelledby="mapTitle">
    <div class="sec-head reveal">
      <p class="sec-kicker">📍 На карте</p>
      <h2 id="mapTitle">${esc(p.cardTitle)} и гостиница «Подсолнух»</h2>
    </div>
    <div class="map-wrap reveal">
      <iframe class="map-frame" title="Карта: ${esc(p.cardTitle)} в Краснодаре" src="https://yandex.ru/map-widget/v1/?text=${q}&amp;z=15" loading="lazy"></iframe>
    </div>
  </section>`;
}

function related(p) {
  const others = data.places.filter(x => x.slug !== p.slug);
  return `  <section class="place-related" aria-labelledby="relatedTitle">
    <div class="sec-head reveal">
      <p class="sec-kicker">🧭 Что ещё рядом</p>
      <h2 id="relatedTitle">Другие точки рядом с «Подсолнухом»</h2>
    </div>
    <div class="near">
${others.map((o, i) => `      <a class="near-card place-next-card reveal${i % 3 ? ' d' + (i % 3) : ''}" href="${o.slug}.html">
        <div><h3>${esc(o.cardTitle)}</h3><p>${esc(o.kicker)}</p></div>
        <span class="near-dist">${esc(o.dist)}</span>
      </a>`).join('\n')}
    </div>
  </section>`;
}

function cta(p) {
  return `  <section class="place-cta reveal" aria-labelledby="ctaTitle">
    <div class="place-cta-copy">
      <h2 id="ctaTitle">Остановитесь в «Подсолнухе»</h2>
      <p>${p.distNote ? esc(p.cardTitle) + ' — ' + esc(p.distNote) + '. ' : ''}Номера с кухней, парковка во дворе, бронь напрямую у собственника.</p>
      <p class="place-cta-note">Цена зависит от даты и количества гостей — уточним по телефону до заселения.</p>
    </div>
    <div class="place-cta-actions">
      <a class="btn primary" href="../rooms.html">Оставить заявку</a>
      <a class="btn max" data-max href="${hotel.max}" target="_blank" rel="noopener noreferrer">MAX</a>
      <a class="btn tg" href="${hotel.tg}" target="_blank" rel="noopener noreferrer">Telegram</a>
      <a class="btn ghost" href="tel:${hotel.phone}">${hotel.phoneHuman}</a>
    </div>
  </section>`;
}

function footer() {
  return `</div>
</main>

<footer>
  <div class="wrap foot">
    <div>
      <strong class="footer-brand"><img class="sunflower-inline" src="../img/sunflower.webp" alt="" aria-hidden="true" /> Подсолнух</strong>
      <p>Уютная гостиница в Краснодаре — номера посуточно напрямую от собственника.</p>
      <p class="foot-note">© <span id="year">2026</span> · Без комиссий и скрытых платежей</p>
    </div>
    <div>
      <strong>Адрес</strong>
      <p>Краснодар, СТ4 Топольки,<br>ул. Цветочная, 162</p>
    </div>
    <div>
      <strong>Связь</strong>
      <p><a href="tel:${hotel.phone}">${hotel.phoneHuman}</a></p>
      <p>
        <a data-max href="${hotel.max}" target="_blank" rel="noopener noreferrer">MAX</a>
        · <a href="${hotel.tg}" target="_blank" rel="noopener noreferrer">Telegram</a>
      </p>
      <p><a href="../index.html#near">Рядом с гостиницей</a></p>
      <p><button type="button" class="privacy-button" id="privacyLink">Политика конфиденциальности</button></p>
    </div>
  </div>
</footer>

<button class="scroll-sun" id="scrollSun" type="button" aria-label="Наверх">
  <img class="scroll-sun-flower" src="../img/sunflower.webp" alt="" aria-hidden="true" width="52" height="52" />
  <svg class="scroll-sun-ring" viewBox="0 0 64 64" aria-hidden="true">
    <circle class="ring-bg" cx="32" cy="32" r="29"/>
    <circle class="ring-fg" cx="32" cy="32" r="29"/>
  </svg>
</button>

<div class="sticky-cta">
  <a class="btn ghost" href="tel:${hotel.phone}">Звонок</a>
  <a class="btn max" data-max href="${hotel.max}" target="_blank" rel="noopener noreferrer">MAX</a>
  <a class="btn primary" href="../rooms.html">Бронь</a>
</div>

<div class="modal-backdrop policy-modal" id="policyModal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="policyTitle" hidden>
  <div class="modal">
    <button class="modal-close" type="button" aria-label="Закрыть">×</button>
    <h3 id="policyTitle">Политика конфиденциальности</h3>
    <p>Настоящая Политика действует в отношении информации, которую сайт гостиницы «Подсолнух» получает во время его использования. Отправка формы бронирования означает согласие с Политикой.</p>
    <p><b>1. Состав данных.</b> Имя и номер телефона — только то, что вы указываете в форме заявки.</p>
    <p><b>2. Цели.</b> Обратная связь с гостем, подбор свободных дат, согласование цены и подтверждение брони. Заявка сохраняется в закрытой Google Таблице, а модератор получает уведомление в Telegram.</p>
    <p><b>3. Конфиденциальность.</b> Данные не продаются и не публикуются. Доступ к заявкам имеют только уполномоченные сотрудники гостиницы.</p>
    <p><b>4. Права гостя.</b> Можно попросить удалить заявку по телефону ${hotel.phoneHuman}.</p>
  </div>
</div>

<div class="modal-backdrop lightbox-modal" id="lightboxModal" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Просмотр фотографии" hidden>
  <div class="lightbox-dialog">
    <button class="modal-close" type="button" aria-label="Закрыть" data-initial-focus>×</button>
    <button class="lightbox-nav lightbox-prev" type="button" id="lightboxPrev" aria-label="Предыдущее фото">‹</button>
    <button class="lightbox-nav lightbox-next" type="button" id="lightboxNext" aria-label="Следующее фото">›</button>
    <div class="lightbox-img-wrap">
      <picture>
        <source id="lightboxSource" srcset="" type="image/webp" />
        <img id="lightboxImg" src="" alt="" width="1600" height="1067" decoding="async" />
      </picture>
    </div>
    <p class="lightbox-count" id="lightboxCount" aria-live="polite"></p>
  </div>
</div>

<script type="module" src="../js/app.js?v=${JS_VERSION}"></script>
</body>
</html>
`;
}

function page(p) {
  return [head(p), header(), crumbs(p), hero(p), intro(p), gallery(p), mapBlock(p), related(p), cta(p), footer()]
    .filter(Boolean).join('\n\n').trimEnd() + '\n';
}

/* ---------- сборка ---------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
data.places.forEach(p => {
  const html = page(p);
  fs.writeFileSync(path.join(OUT_DIR, p.slug + '.html'), html);
  console.log('✓ near/' + p.slug + '.html');
});

// sitemap: главная, бронь, страницы «Рядом»
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: SITE + '/', priority: '1.0', changefreq: 'monthly' },
  { loc: SITE + '/rooms.html', priority: '0.9', changefreq: 'monthly' },
  ...data.places.map(p => ({ loc: SITE + '/near/' + p.slug + '.html', priority: '0.8', changefreq: 'monthly' }))
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
console.log('✓ sitemap.xml');

fs.writeFileSync(path.join(ROOT, 'robots.txt'), `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);
console.log('✓ robots.txt');
