/* =========================================================
   Гостиница «Подсолнух» — основной скрипт
   - форма заявки на бронь (только имя и контакты)
   - модалка политики конфиденциальности и лайтбокс галереи
   - отправка заявки только после записи в Google Таблицу
     (Google Apps Script), откуда модератору уходит уведомление в Telegram
   - публичные настройки (контакты, адрес таблицы) из data/site.json
   - декоративные падающие лепестки и плавные анимации скролла
   ========================================================= */
(function () {
  'use strict';

  // ---------- конфигурация ----------
  var SHARED_CACHE_KEY = 'podsolnuh_shared_v1';

  // Значения по умолчанию; актуальные настройки подгружаются из data/site.json.
  var DEFAULT_CFG = {
    // URL веб-приложения Google Apps Script (таблица броней)
    bookingApi: 'https://script.google.com/macros/s/AKfycbwFY3liVkjJOY9_XHkQ4O8JvX0wkjctoQIzOglTRkmt6UuUafvpfGpIyEh82eyt-nUzzQ/exec',
    tgUrl: 'https://t.me/Olgahotel23',
    maxUrl: 'https://max.ru/u/f9LHodD0cOIbLwgK-CQN6QpeLWldb0OhTsbXg4qW7stL88F9IT36nmEuScw',
    phonePrimary: '+79181164554'
  };

  // общие данные сайта — видны всем посетителям
  var SITE_DATA_PATH = 'data/site.json';
  var SITE_DATA_URLS = [
    SITE_DATA_PATH,
    'https://raw.githubusercontent.com/ckot23/podsolnuh.io/main/data/site.json'
  ];

  // Остатки старой админ-панели в браузере больше не используются — чистим.
  ['podsolnuh_cfg_v1', 'podsolnuh_auth_v1', 'podsolnuh_sync_v1'].forEach(function(k){
    try { localStorage.removeItem(k); } catch(e){}
  });

  var cfg = Object.assign({}, DEFAULT_CFG);
  // Публичные настройки могут загрузиться чуть позже кода страницы. Отправку
  // заявки откладываем до завершения загрузки, чтобы гарантированно использовать актуальный bookingApi.
  var siteDataReady = Promise.resolve(false);
  applySharedData(loadSharedCache(), false);

  // ---------- утилиты ----------
  function loadSharedCache(){
    try { return JSON.parse(localStorage.getItem(SHARED_CACHE_KEY) || 'null'); }
    catch(e){ return null; }
  }
  function phoneHuman(p){
    var d = String(p || '').replace(/\D/g, '');
    if(d.length === 11 && (d[0] === '7' || d[0] === '8')){
      return '8 ' + d.slice(1,4) + ' ' + d.slice(4,7) + '-' + d.slice(7,9) + '-' + d.slice(9,11);
    }
    return String(p || '');
  }
  function applyCfgToDom(){
    if(cfg.tgUrl){
      document.querySelectorAll('a[href*="t.me/"]').forEach(function(a){ a.href = cfg.tgUrl; });
    }
    if(cfg.maxUrl){
      document.querySelectorAll('a[data-max], a[href*="max.ru"]').forEach(function(a){ a.href = cfg.maxUrl; });
    }
    if(cfg.phonePrimary){
      var defDigits = DEFAULT_CFG.phonePrimary.replace(/\D/g, '');
      document.querySelectorAll('a[href^="tel:"]').forEach(function(a){
        var h = a.getAttribute('href') || '';
        if(h.replace(/\D/g, '') === defDigits){ a.href = 'tel:' + cfg.phonePrimary; }
      });
    }
  }
  function applySharedData(data, rerender){
    if(!data || typeof data !== 'object') return false;
    var cfgChanged = false;
    if(data.cfg && typeof data.cfg === 'object'){
      ['tgUrl','maxUrl','phonePrimary','bookingApi'].forEach(function(k){
        if(Object.prototype.hasOwnProperty.call(data.cfg, k) && data.cfg[k] !== cfg[k]){
          cfg[k] = data.cfg[k] || '';
          cfgChanged = true;
        }
      });
    }
    if(cfgChanged && rerender){
      applyCfgToDom();
    }
    return cfgChanged;
  }
  function fetchSiteData(){
    var bust = '?t=' + Date.now();
    var i = 0;
    return new Promise(function(resolve){
      (function tryNext(){
        if(i >= SITE_DATA_URLS.length){ resolve(false); return; }
        var url = SITE_DATA_URLS[i++] + bust;
        fetch(url, { cache: 'no-store', signal: timeoutSignal(5000) }).then(function(r){
          if(!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function(d){
          if(!d || typeof d !== 'object') throw new Error('bad json');
          try { localStorage.setItem(SHARED_CACHE_KEY, JSON.stringify(d)); } catch(e){}
          applySharedData(d, true);
          resolve(true);
        }).catch(function(){ tryNext(); });
      })();
    });
  }
  function phoneOk(v){ var d=(v||'').replace(/\D/g,''); return /^[+\d\s().-]+$/.test(v) && d.length>=10 && d.length<=15 && v.length<=32; }
  function contactsOk(v){ return phoneOk(v); }

  // ---------- общение с Google-таблицей броней ----------
  function bookingApiReady(){
    var url = String(cfg.bookingApi || '').trim();
    return /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url);
  }
  function bookRef(){
    var r = (cfg.bookingApi||'').replace(/\W/g,'').slice(-8);
    return 'p-' + Date.now().toString(36) + '-' + (r||'x') + '-' + Math.random().toString(36).slice(2,8);
  }
  function timeoutSignal(ms){
    if(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    return undefined;
  }
  // POST в Apps Script делаем «простым» multipart-запросом: браузер не делает
  // preflight, который веб-приложение Google не поддерживает.
  function sendToSheet(payload){
    var body = new FormData();
    Object.keys(payload).forEach(function(k){ body.append(k, payload[k]==null?'':String(payload[k])); });
    return fetch(cfg.bookingApi, { method:'POST', body: body, signal: timeoutSignal(12000) })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function(txt){
        var json = null;
        try { json = JSON.parse(txt); } catch(e){}
        return { json: json, text: txt };
      })
      .catch(function(err){ return { json: null, text: '', error: err }; });
  }
  // контрольная проверка: если ответ не пришёл/не разобрался — спрашиваем таблицу, приняла ли она заявку
  function verifyInSheet(ref){
    var url = cfg.bookingApi + (cfg.bookingApi.indexOf('?')===-1?'?':'&') + 'action=verify&ref=' + encodeURIComponent(ref);
    return fetch(url, { signal: timeoutSignal(8000) })
      .then(function(r){ return r.json(); })
      .then(function(j){ return !!(j && j.found); })
      .catch(function(){ return false; });
  }

  // ---------- год в подвале ----------
  document.getElementById('year').textContent = String(new Date().getFullYear());
  applyCfgToDom();
  siteDataReady = fetchSiteData();

  // ---------- скролл: шапка, параллакс, прогресс ----------
  var header=document.getElementById('header');
  var scrollSun=document.getElementById('scrollSun');
  var scrollSunFlower=scrollSun ? scrollSun.querySelector('.scroll-sun-flower') : null;
  var scrollRing=scrollSun ? scrollSun.querySelector('.ring-fg') : null;
  var bigFlower=document.querySelector('.big-sunflower');
  var scrollRaf=0;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function updateScroll(){
    var y = window.scrollY || 0;
    header.classList.toggle('scrolled', y > 8);

    // прогресс страницы — подсолнух крутится, дуга заполняется
    if(scrollSun){
      scrollSun.classList.toggle('show', y > 380);
      var max = (document.documentElement.scrollHeight - window.innerHeight) || 1;
      var pr = Math.min(1, Math.max(0, y / max));
      if(scrollSunFlower) scrollSunFlower.style.rotate = (pr * 540).toFixed(1) + 'deg';
      if(scrollRing) scrollRing.style.strokeDashoffset = (182.2 * (1 - pr)).toFixed(1);
    }

    if(reduce) return;

    // большой подсолнух в hero докручивается вместе со скроллом
    if(bigFlower) bigFlower.style.rotate = (y * 0.12).toFixed(2) + 'deg';

  }
  function onScroll(){
    if(scrollRaf) return;
    scrollRaf = requestAnimationFrame(function(){ scrollRaf = 0; updateScroll(); });
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  window.addEventListener('resize', onScroll, {passive:true});
  updateScroll();

  if(scrollSun) scrollSun.addEventListener('click', function(){
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  });

  // ---------- reveal на скролле ----------
  var revealEls = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .reveal-clip');
  if (reduce || typeof IntersectionObserver==='undefined') {
    revealEls.forEach(function(el){ el.classList.add('visible'); });
  } else {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('visible'); io.unobserve(e.target); } });
    },{threshold:0.1, rootMargin:'0px 0px -50px 0px'});
    revealEls.forEach(function(el){ io.observe(el); });
  }

  // Первый экран и карточки-цифры показываем сразу: они стоят у линии сгиба,
  // и ожидание скролла оставляло на телефоне пустое место под кнопками.
  document.querySelectorAll('.hero .reveal, .hero .reveal-left, .hero .reveal-right, .hero .reveal-scale, .hero .reveal-clip, .stats .reveal, .stats .reveal-scale').forEach(function(el){
    el.classList.add('visible');
  });

  // Страховка на случай, если IntersectionObserver не сработал (бывает во
  // встроенных браузерах мессенджеров): показываем блоки, дошедшие до экрана.
  var revealPending = Array.prototype.slice.call(document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .reveal-clip'))
    .filter(function(el){ return !el.classList.contains('visible'); });
  function revealNearViewport(){
    if(!revealPending.length) return;
    var vh = window.innerHeight || 0;
    revealPending = revealPending.filter(function(el){
      var r = el.getBoundingClientRect();
      if(r.top < vh - 40 && r.bottom > 0){ el.classList.add('visible'); return false; }
      return true;
    });
  }
  window.addEventListener('scroll', function(){ requestAnimationFrame(revealNearViewport); }, {passive:true});
  revealNearViewport();
  // Скрипт на месте — анимации появления можно оставить включёнными.
  document.documentElement.classList.add('anim-ready');

  // ---------- слова заголовков выезжают по одному ----------
  function splitWords(el){
    if(el.dataset.split) return;
    el.dataset.split = '1';
    var wi = 0;
    var frag = document.createDocumentFragment();
    Array.prototype.slice.call(el.childNodes).forEach(function(node){
      if(node.nodeType === 3){
        node.textContent.split(/( +)/).forEach(function(part){
          if(!part) return;
          if(/^ +$/.test(part)){ frag.appendChild(document.createTextNode(' ')); return; }
          var wrap = document.createElement('span'); wrap.className = 'w';
          var inner = document.createElement('span'); inner.className = 'wi';
          inner.textContent = part;
          inner.style.transitionDelay = (wi * 55) + 'ms';
          wi++;
          wrap.appendChild(inner);
          frag.appendChild(wrap);
        });
      } else {
        frag.appendChild(node);
      }
    });
    el.innerHTML = '';
    el.classList.add('split-ready');
    el.appendChild(frag);
  }
  if(!reduce){
    document.querySelectorAll('h2').forEach(function(h){ splitWords(h); });
  }

  // ---------- цифры о гостинице набегают при появлении ----------
  function countUp(el){
    var to = parseInt(el.getAttribute('data-count'), 10) || 0;
    var dur = 1200, t0 = 0;
    el.textContent = '0';
    requestAnimationFrame(function step(ts){
      if(!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(to * e).toLocaleString('ru-RU');
      if(p < 1) requestAnimationFrame(step);
      else el.textContent = to.toLocaleString('ru-RU');
    });
  }
  if(!reduce && typeof IntersectionObserver !== 'undefined'){
    var nio = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(!en.isIntersecting) return;
        en.target.querySelectorAll('.stat-num').forEach(function(el){ countUp(el); });
        nio.unobserve(en.target);
      });
    }, {threshold: 0.4});
    document.querySelectorAll('.stat').forEach(function(st){ nio.observe(st); });
  }

  // ---------- модалки ----------
  var policyModal=document.getElementById('policyModal');
  var lightboxModal=document.getElementById('lightboxModal');
  var lightboxImg=document.getElementById('lightboxImg');
  var lightboxSource=document.getElementById('lightboxSource');
  var lightboxCount=document.getElementById('lightboxCount');
  var galleryItems=Array.prototype.slice.call(document.querySelectorAll('[data-gallery-item]'));
  var galleryIdx=0;
  var form = document.getElementById('bookForm');

  function showGallerySlide(idx){
    if(!galleryItems.length || !lightboxImg) return;
    galleryIdx = (idx + galleryItems.length) % galleryItems.length;
    var item = galleryItems[galleryIdx];
    if(lightboxSource) lightboxSource.srcset = item.getAttribute('data-webp') || '';
    lightboxImg.src = item.getAttribute('data-full') || '';
    lightboxImg.alt = item.getAttribute('data-alt') || '';
    if(lightboxCount) lightboxCount.textContent = (galleryIdx + 1) + ' / ' + galleryItems.length;
  }
  galleryItems.forEach(function(item, i){
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.addEventListener('click', function(){ showGallerySlide(i); openModal(lightboxModal); });
    item.addEventListener('keydown', function(ev){
      if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); showGallerySlide(i); openModal(lightboxModal); }
    });
  });

  function openModal(m){
    if(!m || m.classList.contains('open')) return;
    m._returnFocus = document.activeElement;
    m.hidden = false;
    m.setAttribute('aria-hidden','false');
    m.classList.add('open');
    document.body.style.overflow='hidden';
    var focusTarget = m.querySelector('[data-initial-focus]') || m.querySelector('button, input, [tabindex="0"]');
    if(focusTarget) requestAnimationFrame(function(){ focusTarget.focus(); });
  }
  function closeModal(m){
    if(!m||!m.classList.contains('open')) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden','true');
    m.hidden = true;
    document.body.style.overflow = document.querySelector('.modal-backdrop.open') ? 'hidden' : '';
    if(m._returnFocus && m._returnFocus.isConnected) m._returnFocus.focus();
  }

  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-book]');
    if(b){
      var section = document.getElementById('booking') || form;
      if(section) section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      var nameInput = document.getElementById('fName');
      if(nameInput) nameInput.focus();
      return;
    }
    if(e.target.closest('#lightboxPrev')){ showGallerySlide(galleryIdx - 1); return; }
    if(e.target.closest('#lightboxNext')){ showGallerySlide(galleryIdx + 1); return; }
    if(e.target.closest('#privacyLink, [data-policy]')){ e.preventDefault(); openModal(policyModal); return; }
    if(e.target.closest('.modal-close')){ closeModal(e.target.closest('.modal-backdrop')); return; }
    if(e.target===policyModal) closeModal(policyModal);
    if(e.target===lightboxModal) closeModal(lightboxModal);
  });
  document.addEventListener('keydown', function(e){
    var opened = document.querySelectorAll('.modal-backdrop.open');
    var activeModal = opened[opened.length - 1];
    if(!activeModal) return;
    if(e.key==='Escape'){ closeModal(activeModal); return; }
    if(activeModal===lightboxModal && e.key==='ArrowLeft'){ e.preventDefault(); showGallerySlide(galleryIdx - 1); return; }
    if(activeModal===lightboxModal && e.key==='ArrowRight'){ e.preventDefault(); showGallerySlide(galleryIdx + 1); return; }
    if(e.key==='Tab'){
      var focusable = Array.prototype.slice.call(activeModal.querySelectorAll('button, input, a[href], [tabindex]'))
        .filter(function(el){ return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length; });
      var first = focusable[0], last = focusable[focusable.length - 1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
  });

  // ---------- форма заявки на бронь (только имя и контакты) ----------
  function setStatus(text,state){
    var el=document.getElementById('formStatus');
    if(!el) return;
    el.textContent=text||''; el.setAttribute('data-state', state||'');
  }
  function showErr(id,on){
    var el=document.getElementById(id);
    if(el) el.classList.toggle('show',!!on);
    var control = document.getElementById({errName:'fName',errPhone:'fPhone'}[id]);
    if(control) control.setAttribute('aria-invalid', on ? 'true' : 'false');
  }
  ['fName','fPhone'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener('input', function(){ showErr(id === 'fName' ? 'errName' : 'errPhone', false); });
  });

  if(form) form.addEventListener('submit', function(e){
    e.preventDefault();
    if(form.getAttribute('aria-busy') === 'true') return;
    ['errName','errPhone'].forEach(function(id){ showErr(id,false); });
    setStatus('', '');
    var name = document.getElementById('fName').value.trim();
    var contactsEl = document.getElementById('fPhone') || document.getElementById('fContacts');
    var contacts = contactsEl ? contactsEl.value.trim() : '';
    var honeypot = document.getElementById('website').value.trim();
    if(honeypot) return;

    var firstInvalid = null;
    if(name.length < 2 || name.length > 100){ showErr('errName',true); firstInvalid = document.getElementById('fName'); }
    if(!contactsOk(contacts)){ showErr('errPhone',true); firstInvalid = firstInvalid || contactsEl; }
    if(firstInvalid){ firstInvalid.focus(); return; }

    var data = { name: name, contacts: contacts, phone: contacts, website: honeypot };
    var btn=document.getElementById('submitBtn');
    btn.disabled=true;
    btn.textContent='Отправляем…';
    form.setAttribute('aria-busy','true');
    setStatus('Отправляем заявку…','info');

    // Успех только после записи в таблицу (id или action=verify), не по отправке в Telegram.
    siteDataReady.then(function(){
      if(!bookingApiReady()) throw new Error('Не настроен адрес Google Apps Script.');
      return submitToSheet(data);
    }).then(function(res){
      resetBookingForm();
      var num = res && res.id ? ' №'+res.id : '';
      if(res && res.notified === false){
        setStatus('Заявка'+num+' записана в таблицу, но уведомление модератору не отправлено. Для быстрой связи позвоните: '+phoneHuman(cfg.phonePrimary)+'.','info');
      } else {
        setStatus('✅ Заявка'+num+' принята. Мы скоро свяжемся с вами для подтверждения брони.','ok');
      }
    }).catch(function(err){
      console.error('Не удалось отправить заявку:', err);
      var msg = String((err && err.message) || '');
      if(/даты|номер|setup\(\)/i.test(msg)){
        setStatus('Не удалось отправить заявку: обновите скрипт Google Apps Script (Code.gs), разверните новую версию и выполните setup(), либо позвоните нам: '+phoneHuman(cfg.phonePrimary)+'.','error');
      } else {
        setStatus('Не удалось отправить заявку. Попробуйте ещё раз или позвоните: '+phoneHuman(cfg.phonePrimary)+'.','error');
      }
    }).finally(function(){
      btn.disabled=false;
      btn.textContent='Отправить заявку';
      form.setAttribute('aria-busy','false');
    });
  });

  function resetBookingForm(){
    if(!form) return;
    form.reset();
    ['errName','errPhone'].forEach(function(id){ showErr(id,false); });
  }

  /**
   * Заявка в Google Таблицу (Apps Script). Если ответа нет,
   * спрашиваем таблицу, приняла ли она заявку по нашему ref — так заявка
   * не теряется при обрыве связи, и гость не отправляет её дважды.
   */
  function submitToSheet(data){
    var payload = {
      action: 'book',
      name: data.name,
      contacts: data.contacts || data.phone,
      phone: data.phone || data.contacts,
      website: data.website,
      ref: bookRef()
    };
    return sendToSheet(payload).then(function(res){
      var j = res && res.json;
      // Apps Script возвращает id только после записи строки в таблицу.
      if(j && j.ok && Number(j.id) > 0) return j;
      var message = j && j.error ? j.error : (res && res.error ? res.error.message : 'таблица не подтвердила приём');
      if(j && j.ignored) message = 'Заявка не прошла проверку формы.';
      return verifyInSheet(payload.ref).then(function(found){
        if(found) return { ok:true, verified:true };
        throw new Error(message);
      });
    });
  }

  // ---------- ДЕКОРАТИВНЫЕ ПАДАЮЩИЕ ЛЕПЕСТКИ ----------
  (function petals(){
    if(reduce) return;
    var layer = document.getElementById('decoLayer');
    if(!layer) return;
    var isSmall = window.innerWidth < 700;
    for(var i=0;i<(isSmall?5:10);i++){
      var d = document.createElement('div');
      var isLeaf = Math.random()>0.6;
      d.className = 'deco '+(isLeaf?'leaf':'petal');
      d.style.left = (Math.random()*100)+'%';
      d.style.top = (Math.random()*100)+'%';
      var speed = 4+Math.random()*6;
      d.style.animation = (Math.random()>0.5?'float-slow':(Math.random()>0.5?'float-med':'float-fast'))+' '+speed+'s ease-in-out infinite';
      d.style.animationDelay = (-Math.random()*speed)+'s';
      if(isLeaf) d.style.transform = 'rotate('+(Math.random()*360)+'deg)';
      d.style.opacity = 0.25+Math.random()*0.35;
      layer.appendChild(d);
    }
    function spawnFallingPetal(){
      var p = document.createElement('div');
      p.className='falling-petal';
      var size = 14+Math.random()*14;
      p.style.width = size+'px';
      p.style.height = (size*0.65)+'px';
      p.style.left = (Math.random()*100)+'%';
      p.style.background = 'radial-gradient(ellipse at 30% 40%, #ffe082, #f7a93c 70%)';
      p.style.borderRadius = '60% 40% 60% 40% / 70% 60% 40% 30%';
      p.style.filter='drop-shadow(0 2px 6px rgba(200,120,20,.2))';
      p.style.setProperty('--drift', ((Math.random()*200-100))+'px');
      var dur = 8+Math.random()*10;
      p.style.animationDuration = dur+'s';
      p.style.animationDelay = (-Math.random()*dur)+'s';
      layer.appendChild(p);
      setTimeout(function(){ p.remove(); }, dur*1000+100);
    }
    setInterval(spawnFallingPetal, isSmall?3600:2200);
    for(var k=0;k<(isSmall?3:6);k++) setTimeout(spawnFallingPetal, k*400);
  })();

})();
