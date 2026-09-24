import { ROOMS } from './rooms.js';

/* =========================================================
   Гостиница «Подсолнух» — основной скрипт
   - календарь выбора диапазона
   - модалки, валидация
   - отправка в Telegram (через bot API, если настроен токен,
     иначе — открывает t.me с готовым текстом)
   - админ-панель со статусами номеров (сохраняются в localStorage)
   - декоративные падающие лепестки
   ========================================================= */
(function () {
  'use strict';

  // ---------- конфигурация ----------
  var CONFIG_KEY = 'podsolnuh_cfg_v1';
  var STATUS_KEY = 'podsolnuh_status_v1';
  var AUTH_KEY   = 'podsolnuh_auth_v1';
  var SYNC_KEY   = 'podsolnuh_sync_v1';
  var SHARED_CACHE_KEY = 'podsolnuh_shared_v1';
  var ADMIN_PASSWORD = 'sunflower'; // <<< поменяйте на свой пароль

  var DEFAULT_CFG = {
    botToken: '',
    chatId: '',
    tgUrl: 'https://t.me/ckot_23',
    waNumber: '79882443223',
    phonePrimary: '+79181164554',
  };

  // общие данные сайта — видны всем посетителям
  var SITE_DATA_PATH = 'data/site.json';
  var SITE_DATA_URLS = [
    SITE_DATA_PATH,
    'https://raw.githubusercontent.com/ckot23/podsolnuh.io/main/data/site.json'
  ];
  var DEFAULT_SYNC = { repo: 'ckot23/podsolnuh.io', branch: 'main', token: '' };

  var cfg = loadCfg();
  var statuses = loadStatuses();
  var sync = loadSync();
  var adminAuthed = !!localStorage.getItem(AUTH_KEY);
  applySharedData(loadSharedCache(), false);

  var MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

  // ---------- утилиты ----------
  function pad(n){ return n<10 ? '0'+n : ''+n; }
  function loadCfg(){
    try { var c = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); return Object.assign({}, DEFAULT_CFG, c); }
    catch(e){ return Object.assign({}, DEFAULT_CFG); }
  }
  function saveCfg(){ localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }
  function loadStatuses(){
    try {
      var s = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}');
      ROOMS.forEach(function(r){ if (s[r.id] !== 'busy' && s[r.id] !== 'free') s[r.id] = 'free'; });
      return s;
    } catch(e){ var m={}; ROOMS.forEach(function(r){ m[r.id]='free'; }); return m; }
  }
  function saveStatuses(){ localStorage.setItem(STATUS_KEY, JSON.stringify(statuses)); }

  // ---------- синхронизация: изменения для ВСЕГО сайта ----------
  function loadSync(){
    try { return Object.assign({}, DEFAULT_SYNC, JSON.parse(localStorage.getItem(SYNC_KEY) || '{}')); }
    catch(e){ return Object.assign({}, DEFAULT_SYNC); }
  }
  function saveSync(){ localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); }
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
  // применяем настройки ко всем ссылкам сайта, а не только к панели
  function applyCfgToDom(){
    if(cfg.tgUrl){
      document.querySelectorAll('a[href*="t.me/"]').forEach(function(a){ a.href = cfg.tgUrl; });
    }
    if(cfg.waNumber){
      var wa = 'https://wa.me/' + String(cfg.waNumber).replace(/\D/g, '');
      document.querySelectorAll('a[href*="wa.me/"]').forEach(function(a){ a.href = wa; });
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
    var cfgChanged = false, stChanged = false;
    if(data.cfg && typeof data.cfg === 'object'){
      ['tgUrl','waNumber','phonePrimary','botToken','chatId'].forEach(function(k){
        if(Object.prototype.hasOwnProperty.call(data.cfg, k) && data.cfg[k] !== cfg[k]){
          cfg[k] = data.cfg[k] || '';
          cfgChanged = true;
        }
      });
      if(cfgChanged) saveCfg();
    }
    if(data.statuses && typeof data.statuses === 'object'){
      ROOMS.forEach(function(r){
        var v = data.statuses[r.id];
        if((v === 'busy' || v === 'free') && statuses[r.id] !== v){ statuses[r.id] = v; stChanged = true; }
      });
      if(stChanged) saveStatuses();
    }
    if((cfgChanged || stChanged) && rerender){
      applyCfgToDom();
      renderRooms();
    }
    return cfgChanged || stChanged;
  }
  function buildSiteData(){
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      statuses: statuses,
      cfg: {
        tgUrl: cfg.tgUrl,
        waNumber: cfg.waNumber,
        phonePrimary: cfg.phonePrimary,
        botToken: cfg.botToken,
        chatId: cfg.chatId
      }
    };
  }
  function pushSiteData(){
    if(!sync.token || !sync.repo || !sync.branch){
      return Promise.reject(new Error('не настроена GitHub-синхронизация'));
    }
    var content = JSON.stringify(buildSiteData(), null, 2);
    var b64 = btoa(unescape(encodeURIComponent(content)));
    var headers = { 'Authorization': 'Bearer ' + sync.token, 'Accept': 'application/vnd.github+json' };
    return fetch('https://api.github.com/repos/' + sync.repo + '/contents/' + SITE_DATA_PATH + '?ref=' + encodeURIComponent(sync.branch), { headers: headers })
      .then(function(r){
        if(r.status === 404) return null;
        if(!r.ok) throw new Error('чтение файла: HTTP ' + r.status);
        return r.json();
      })
      .then(function(cur){
        var body = { message: 'Update data/site.json from admin panel', content: b64, branch: sync.branch };
        if(cur && cur.sha) body.sha = cur.sha;
        return fetch('https://api.github.com/repos/' + sync.repo + '/contents/' + SITE_DATA_PATH, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + sync.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      })
      .then(function(r){
        return r.json().then(function(j){
          if(!r.ok) throw new Error((j && j.message) || ('запись файла: HTTP ' + r.status));
          return j;
        });
      });
  }
  function fetchSiteData(){
    var bust = '?t=' + Date.now();
    var i = 0;
    (function tryNext(){
      if(i >= SITE_DATA_URLS.length) return;
      var url = SITE_DATA_URLS[i++] + bust;
      fetch(url, { cache: 'no-store' }).then(function(r){
        if(!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(d){
        if(!d || typeof d !== 'object') throw new Error('bad json');
        try { localStorage.setItem(SHARED_CACHE_KEY, JSON.stringify(d)); } catch(e){}
        applySharedData(d, true);
      }).catch(function(){ tryNext(); });
    })();
  }
  function adminMsg(text, state, ms){
    var note = document.getElementById('adminNote');
    if(!note) return;
    note.textContent = text;
    if(state) note.setAttribute('data-state', state); else note.removeAttribute('data-state');
    clearTimeout(adminMsg._t);
    if(ms !== 0) adminMsg._t = setTimeout(function(){ note.textContent = ''; note.removeAttribute('data-state'); }, ms || 3000);
  }
  function maybePushGlobal(okMsg){
    if(!sync.token){
      adminMsg('💾 Сохранено в этом браузере. Чтобы увидели все посетители — заполните GitHub-синхронизацию ниже.', 'info', 6000);
      return;
    }
    adminMsg('Синхронизируем с сайтом…', 'info', 0);
    pushSiteData().then(function(){
      adminMsg(okMsg || '✅ Применено для всего сайта!', 'ok');
    }).catch(function(err){
      adminMsg('⚠️ Локально сохранено, но не применено глобально: ' + err.message, 'error', 6000);
    });
  }

  function monthMatrix(y,m){
    var first = new Date(y,m,1);
    var offset = (first.getDay()+6) % 7;
    var days = new Date(y,m+1,0).getDate();
    var cells=[];
    for(var i=0;i<offset;i++) cells.push(null);
    for(var d=1;d<=days;d++) cells.push(new Date(y,m,d));
    return cells;
  }
  function nightsBetween(a,b){ return Math.round((b-a)/86400000); }
  function sameDay(a,b){ return a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function rangeLabel(a,b){
    if(!a) return '';
    if(!b) return pad(a.getDate())+'.'+pad(a.getMonth()+1)+' — выберите выезд';
    return pad(a.getDate())+'.'+pad(a.getMonth()+1)+'–'+pad(b.getDate())+'.'+pad(b.getMonth()+1)+' ('+nightsBetween(a,b)+' сут.)';
  }
  function phoneOk(v){ var d=(v||'').replace(/\D/g,''); return d.length>=10 && d.length<=12; }

  // ---------- год в подвале ----------
  document.getElementById('year').textContent = String(new Date().getFullYear());
  applyCfgToDom();
  fetchSiteData();

  // ---------- скролл: шапка, параллакс, прогресс ----------
  var header=document.getElementById('header');
  var scrollSun=document.getElementById('scrollSun');
  var scrollSunFlower=scrollSun ? scrollSun.querySelector('.scroll-sun-flower') : null;
  var scrollRing=scrollSun ? scrollSun.querySelector('.ring-fg') : null;
  var heroWrap=document.querySelector('.hero-photo-wrap');
  var badgePrice=document.querySelector('.badge-price');
  var badgeDist=document.querySelector('.badge-dist');
  var bigFlower=document.querySelector('.big-sunflower');
  var heroVisual=document.querySelector('.hero-visual');
  var scrollRaf=0;

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

    // параллакс hero: фото и бейджи движутся с разной скоростью
    if(heroVisual){
      var r = heroVisual.getBoundingClientRect();
      if(r.bottom > -140 && r.top < window.innerHeight + 140){
        var mid = r.top + r.height / 2 - window.innerHeight / 2;
        if(heroWrap) heroWrap.style.translate = '0 ' + (mid * -0.07).toFixed(1) + 'px';
        if(badgePrice) badgePrice.style.translate = '0 ' + (mid * 0.05).toFixed(1) + 'px';
        if(badgeDist) badgeDist.style.translate = '0 ' + (mid * -0.06).toFixed(1) + 'px';
      }
    }
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
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof IntersectionObserver==='undefined') {
    revealEls.forEach(function(el){ el.classList.add('visible'); });
  } else {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('visible'); io.unobserve(e.target); } });
    },{threshold:0.1, rootMargin:'0px 0px -50px 0px'});
    revealEls.forEach(function(el){ io.observe(el); });
  }

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

  // ---------- слайдер фотографий номера ----------
  function webpPath(src){ return src.replace(/\.jpe?g$/i, '.webp'); }
  function pictureMarkup(photo, className, loading){
    var cls = className ? ' class="'+className+'"' : '';
    return '<picture>' +
      '<source srcset="'+webpPath(photo.src)+'" type="image/webp" />' +
      '<img'+cls+' src="'+photo.src+'" alt="'+photo.alt+'" width="1408" height="768" loading="'+(loading || 'lazy')+'" decoding="async" />' +
    '</picture>';
  }
  function buildSlider(room){
    var photos = room.photos || [];
    if(!photos.length) return '';
    var many = photos.length > 1;
    var slides = photos.map(function(p){
      return '<div class="slide">'+pictureMarkup(p, '', 'lazy')+'</div>';
    }).join('');
    var html = '<div class="photo-slider" data-slider>' +
      '<div class="slider-track" tabindex="0" role="group" aria-label="Фотографии: '+room.name+'">'+slides+'</div>';
    if(many){
      var dots = photos.map(function(_, i){
        return '<button type="button" class="slider-dot'+(i===0?' active':'')+'" data-idx="'+i+'" aria-label="Фото '+(i+1)+' из '+photos.length+'"></button>';
      }).join('');
      html += '<button type="button" class="slider-nav slider-prev" aria-label="Предыдущее фото">‹</button>' +
        '<button type="button" class="slider-nav slider-next" aria-label="Следующее фото">›</button>' +
        '<div class="slider-ind"><span class="slider-dots">'+dots+'</span><span class="slider-count">1/'+photos.length+'</span></div>';
    }
    return html + '</div>';
  }

  function initSliders(root){
    (root || document).querySelectorAll('[data-slider]').forEach(function(sl){
      if(sl.dataset.sliderReady) return;
      sl.dataset.sliderReady = '1';
      var track = sl.querySelector('.slider-track');
      var total = track ? track.children.length : 0;
      if(!total) return;
      // Оставляем изображения lazy: браузер сам подгрузит их перед свайпом.
      if(total < 2) return;
      var dots = sl.querySelectorAll('.slider-dot');
      var count = sl.querySelector('.slider-count');
      var prev = sl.querySelector('.slider-prev');
      var next = sl.querySelector('.slider-next');
      var cur = 0, rafId = 0;
      function idx(){
        return Math.max(0, Math.min(total-1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
      }
      function sync(i){
        dots.forEach(function(d, di){ d.classList.toggle('active', di === i); });
        if(count) count.textContent = (i+1)+'/'+total;
        if(prev) prev.disabled = (i === 0);
        if(next) next.disabled = (i === total-1);
      }
      function paint(i){ if(i !== cur){ cur = i; sync(i); } }
      function goTo(i){
        i = Math.max(0, Math.min(total-1, i));
        cur = i; sync(i);
        track.scrollTo({ left: i * track.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
      }
      track.addEventListener('scroll', function(){
        if(rafId) return;
        rafId = requestAnimationFrame(function(){ rafId = 0; paint(idx()); });
      }, {passive: true});
      track.addEventListener('keydown', function(e){
        if(e.key === 'ArrowLeft'){ e.preventDefault(); goTo(idx()-1); }
        if(e.key === 'ArrowRight'){ e.preventDefault(); goTo(idx()+1); }
      });
      if(prev) prev.addEventListener('click', function(){ goTo(idx()-1); });
      if(next) next.addEventListener('click', function(){ goTo(idx()+1); });
      dots.forEach(function(d){
        d.addEventListener('click', function(){ goTo(parseInt(d.dataset.idx, 10) || 0); });
      });
      window.addEventListener('resize', function(){
        track.scrollLeft = cur * track.clientWidth;
      }, {passive: true});
      if(prev) prev.disabled = true;
    });
  }

  // ---------- рендер карточек номеров ----------
  function renderRooms(){
    var list = document.getElementById('roomsList');
    list.innerHTML = '';
    ROOMS.forEach(function(r, i){
      var busy = statuses[r.id]==='busy';
      var art = document.createElement('article');
      art.className = 'room reveal ' + (i%2 ? 'd1' : '') + (busy?' room-busy':'');
      art.dataset.room = r.id;
      art.innerHTML =
        '<div class="room-photo">' +
          buildSlider(r) +
          '<span class="room-addr">'+r.addr+'</span>' +
          '<span class="status-chip '+(busy?'busy':'free')+'">'+(busy?'🚫 Занят':'🌻 Свободен')+'</span>' +
          '<span class="room-price">от '+r.price.toLocaleString('ru-RU')+' ₽ <small>/ сутки</small></span>' +
        '</div>' +
        '<div class="room-body">' +
          '<h3>'+r.name+'</h3>' +
          '<span class="room-guests"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'+r.guests+'</span>' +
          '<p class="room-desc">'+r.desc+'</p>' +
          '<ul class="chips">'+r.chips.map(function(c){return '<li>'+c+'</li>';}).join('')+'</ul>' +
          '<div class="room-cta">' +
            '<button class="btn primary" type="button" data-book="'+r.id+'" '+(busy?'disabled':'')+'>'+(busy?'Сейчас занят':'Забронировать')+'</button>' +
            '<a class="btn ghost" href="tel:'+cfg.phonePrimary+'">Уточнить цену</a>' +
          '</div>' +
        '</div>';
      list.appendChild(art);
    });
    initSliders(list);
    if (io) list.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
    renderRoomPicker();
  }

  // ---------- красивый выбор гостей ----------
  var GUEST_OPTIONS = [
    { v:'1',  num:'1', label:'гость' },
    { v:'2',  num:'2', label:'гостя' },
    { v:'3',  num:'3', label:'гостя' },
    { v:'4',  num:'4', label:'гостя' },
    { v:'5+', num:'5+',label:'гостей' }
  ];
  var selectedGuests = '2';
  function renderGuestsPicker(){
    var picker = document.getElementById('guestsPicker');
    if(!picker) return;
    picker.innerHTML = '';
    GUEST_OPTIONS.forEach(function(g){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'guest-option' + (selectedGuests===g.v?' selected':'');
      btn.setAttribute('role','radio');
      btn.setAttribute('aria-checked', selectedGuests===g.v ? 'true':'false');
      btn.innerHTML = '<span class="g-num">'+g.num+'</span><span class="g-label">'+g.label+'</span>';
      btn.addEventListener('click', function(){
        selectedGuests = g.v;
        document.getElementById('fGuests').value = g.v;
        renderGuestsPicker();
      });
      picker.appendChild(btn);
    });
    document.getElementById('fGuests').value = selectedGuests;
  }

  // ---------- красивый выбор номера в модалке ----------
  var selectedRoom = '';
  function renderRoomPicker(){
    var picker = document.getElementById('roomPicker');
    if(!picker) return;
    picker.innerHTML = '';
    ROOMS.forEach(function(r){
      var busy = statuses[r.id]==='busy';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'room-option' + (busy?' busy':'') + (selectedRoom===r.id && !busy?' selected':'');
      btn.setAttribute('role','radio');
      btn.setAttribute('aria-checked', selectedRoom===r.id && !busy ? 'true':'false');
      btn.dataset.room = r.id;
      if(busy) btn.disabled = true;
      btn.innerHTML =
        pictureMarkup({src:r.photos[0].src, alt:r.name}, 'opt-photo', 'lazy') +
        '<div class="opt-body">' +
          '<span class="opt-name">'+r.name+'</span>' +
          '<div class="opt-price">'+r.price.toLocaleString('ru-RU')+' ₽ <small>/ сутки</small></div>' +
          '<div class="opt-guests">'+r.guests+' · '+r.addr+'</div>' +
        '</div>' +
        (busy?'<span class="opt-busy-badge">Занят</span>':'');
      btn.addEventListener('click', function(){
        if(busy) return;
        selectedRoom = r.id;
        document.getElementById('fRoom').value = r.id;
        renderRoomPicker();
      });
      picker.appendChild(btn);
    });
    // если текущий выбранный занят или пуст — выбрать первый свободный
    var current = ROOMS.find(function(x){return x.id===selectedRoom;});
    if(!current || statuses[selectedRoom]==='busy'){
      var firstFree = ROOMS.find(function(x){ return statuses[x.id]!=='busy'; });
      selectedRoom = firstFree ? firstFree.id : '';
      document.getElementById('fRoom').value = selectedRoom;
      // перерендерим чтобы выделение применилось
      if(firstFree){
        picker.querySelectorAll('.room-option').forEach(function(el){
          el.classList.toggle('selected', el.dataset.room===selectedRoom);
          el.setAttribute('aria-checked', el.dataset.room===selectedRoom ? 'true':'false');
        });
      }
    } else {
      document.getElementById('fRoom').value = selectedRoom;
    }
  }
  renderRooms();
  renderGuestsPicker();

  // ---------- модалки ----------
  var bookModal=document.getElementById('bookModal');
  var policyModal=document.getElementById('policyModal');
  var adminModal=document.getElementById('adminModal');
  var lastFocus=null;

  function openModal(m){
    if(!m) return;
    lastFocus=document.activeElement;
    m.hidden = false;
    m.setAttribute('aria-hidden','false');
    m.classList.add('open');
    document.body.style.overflow='hidden';
    var focusTarget = m.querySelector('button, input, [tabindex="0"]');
    if(focusTarget) requestAnimationFrame(function(){ focusTarget.focus(); });
  }
  function closeModal(m){
    if(!m||!m.classList.contains('open')) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden','true');
    m.hidden = true;
    document.body.style.overflow='';
    if(lastFocus&&lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-book]');
    if(b){
      var rid = b.getAttribute('data-book');
      if(rid && statuses[rid]!=='busy'){
        selectedRoom = rid;
      } else {
        var ff = ROOMS.find(function(r){ return statuses[r.id]!=='busy'; });
        selectedRoom = ff ? ff.id : '';
      }
      renderRoomPicker();
      openModal(bookModal); return;
    }
    if(e.target.closest('#privacyLink')){ e.preventDefault(); openModal(policyModal); return; }
    if(e.target.closest('#adminLink')){ e.preventDefault(); openAdmin(); return; }
    if(e.target.closest('.modal-close')){ closeModal(bookModal); closeModal(policyModal); closeModal(adminModal); return; }
    if(e.target===bookModal) closeModal(bookModal);
    if(e.target===policyModal) closeModal(policyModal);
    if(e.target===adminModal) closeModal(adminModal);
  });
  document.addEventListener('keydown', function(e){
    if(e.key==='Escape'){ closeModal(bookModal); closeModal(policyModal); closeModal(adminModal); }
  });

  // ---------- календарь ----------
  var calGrid=document.getElementById('calGrid');
  var calTitle=document.getElementById('calTitle');
  var calLabel=document.getElementById('calLabel');
  var datesInput=document.getElementById('fDates');
  var today=new Date(); today.setHours(0,0,0,0);
  var view={y:today.getFullYear(), m:today.getMonth()};
  var selStart=null, selEnd=null;

  function renderCalendar(){
    if(!calGrid) return;
    calTitle.textContent = MONTHS[view.m]+' '+view.y;
    calGrid.innerHTML='';
    monthMatrix(view.y,view.m).forEach(function(day){
      var cell=document.createElement('button');
      cell.type='button';
      if(!day){ cell.className='cal-day empty'; cell.disabled=true; calGrid.appendChild(cell); return; }
      cell.className='cal-day';
      cell.textContent = String(day.getDate());
      cell.setAttribute('data-date', day.toISOString());
      if(day < today) cell.disabled=true;
      if(sameDay(day,today)) cell.classList.add('today');
      if(sameDay(day,selStart)) cell.classList.add('range-start');
      if(sameDay(day,selEnd)) cell.classList.add('range-end');
      if(selStart && selEnd && day>selStart && day<selEnd) cell.classList.add('in-range');
      calGrid.appendChild(cell);
    });
    calLabel.textContent = selStart ? rangeLabel(selStart,selEnd) : 'Выберите дату заезда';
    datesInput.value = (selStart && selEnd) ? rangeLabel(selStart,selEnd) : '';
  }
  if(calGrid){
    calGrid.addEventListener('click',function(e){
      var btn=e.target.closest('.cal-day');
      if(!btn||btn.disabled||!btn.getAttribute('data-date')) return;
      var day=new Date(btn.getAttribute('data-date'));
      if(!selStart || (selStart&&selEnd)){ selStart=day; selEnd=null; }
      else if(day<selStart){ selStart=day; }
      else if(sameDay(day,selStart)){ selStart=null; }
      else { selEnd=day; }
      renderCalendar();
    });
    document.getElementById('calPrev').addEventListener('click',function(){ view.m--; if(view.m<0){view.m=11;view.y--;} renderCalendar(); });
    document.getElementById('calNext').addEventListener('click',function(){ view.m++; if(view.m>11){view.m=0;view.y++;} renderCalendar(); });
    renderCalendar();
  }

  // ---------- форма брони ----------
  function buildText(d){
    var lines=['🌻 Новая заявка — Гостиница Подсолнух','','Имя: '+d.name,'Телефон: '+d.phone];
    if(d.dates) lines.push('Даты: '+d.dates);
    lines.push('Гостей: '+d.guests);
    if(d.roomLabel) lines.push('Номер: '+d.roomLabel);
    return lines.join('\n');
  }
  function setStatus(text,state){
    var el=document.getElementById('formStatus');
    el.textContent=text||''; el.setAttribute('data-state', state||'');
  }
  function showErr(id,on){ var el=document.getElementById(id); if(el) el.classList.toggle('show',!!on); }

  function escapeHtml(s){ return String(s).replace(/[&<>]/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

  function sendViaBotApi(data){
    var roomName = ROOMS.find(function(r){return r.id===data.room;});
    var payload = {
      name: data.name, phone: data.phone, dates: data.dates, guests: data.guests, roomId: data.room,
      roomLabel: roomName? roomName.label : (data.room||'не выбран')
    };
    var lines=[
      '🌻 <b>Новая заявка — Подсолнух</b>',
      '',
      '👤 <b>Имя:</b> '+escapeHtml(payload.name),
      '📞 <b>Телефон:</b> '+escapeHtml(payload.phone),
      '📅 <b>Даты:</b> '+escapeHtml(payload.dates||'не указаны'),
      '👥 <b>Гостей:</b> '+escapeHtml(payload.guests),
      '🛏 <b>Номер:</b> '+escapeHtml(payload.roomLabel)
    ];
    var text = lines.join('\n');
    var url = 'https://api.telegram.org/bot'+cfg.botToken+'/sendMessage';
    var body = new URLSearchParams();
    body.set('chat_id', cfg.chatId);
    body.set('text', text);
    body.set('parse_mode','HTML');
    return fetch(url, { method:'POST', body: body, signal: AbortSignal.timeout(10000) }).then(function(r){ return r.json(); });
  }

  var form = document.getElementById('bookForm');
  form.addEventListener('submit', function(e){
    e.preventDefault();
    showErr('errName',false); showErr('errPhone',false);
    var name = document.getElementById('fName').value.trim();
    var phone = document.getElementById('fPhone').value.trim();
    var dates = datesInput.value.trim();
    var guests = document.getElementById('fGuests').value;
    var room = document.getElementById('fRoom').value;
    var roomObj = ROOMS.find(function(r){return r.id===room;});
    var roomLabel = roomObj ? roomObj.label : '';
    var honeypot = document.getElementById('website').value.trim();
    if(honeypot) return;

    var ok=true;
    if(name.length<2){ showErr('errName',true); ok=false; }
    if(!phoneOk(phone)){ showErr('errPhone',true); ok=false; }
    if(!room || !roomObj){
      setStatus('Пожалуйста, выберите номер.','error'); ok=false;
    }
    if(!ok) return;
    if(statuses[room]==='busy'){
      setStatus('Этот номер сейчас занят — выберите другой.','error'); return;
    }

    var data={name:name, phone:phone, dates:dates, guests:guests, room:room, roomLabel:roomLabel};
    var btn=document.getElementById('submitBtn');
    btn.disabled=true;
    setStatus('Отправляем в Telegram…','info');

    // Если настроен бот — шлём через API, иначе открываем t.me с готовым текстом
    if(cfg.botToken && cfg.chatId){
      sendViaBotApi(data).then(function(res){
        if(res && res.ok){
          form.reset();
          selStart=null; selEnd=null; renderCalendar();
          selectedGuests='2'; renderGuestsPicker();
          var ff=ROOMS.find(function(x){return statuses[x.id]!=='busy';});
          selectedRoom=ff?ff.id:''; renderRoomPicker();
          setStatus('✅ Заявка отправлена! Сообщение уже доставлено в Telegram. Перезвоним в ближайшее время.','ok');
        } else {
          throw new Error((res&&res.description)||'api');
        }
      }).catch(function(err){
        // fallback — открываем чат
        var msg = encodeURIComponent(buildText(data));
        window.open(cfg.tgUrl+'?text='+msg, '_blank','noopener');
        setStatus('⚠️ Не удалось доставить автоматически — открыли чат Telegram. Или звоните: '+phoneHuman(cfg.phonePrimary)+'.','error');
      }).finally(function(){ btn.disabled=false; });
    } else {
      var msg = encodeURIComponent(buildText(data));
      window.open(cfg.tgUrl+'?text='+msg, '_blank','noopener');
      setStatus('✅ Открыли Telegram с готовой заявкой — нажмите «отправить». Если не открылось — звоните: '+phoneHuman(cfg.phonePrimary)+'.','ok');
      btn.disabled=false;
    }
  });

  // ---------- АДМИНКА ----------
  function openAdmin(){
    openModal(adminModal);
    if(adminAuthed){
      document.getElementById('adminLogin').hidden = true;
      document.getElementById('adminPanel').hidden = false;
      renderAdminRooms();
      document.getElementById('cfgToken').value = cfg.botToken||'';
      document.getElementById('cfgChat').value = cfg.chatId||'';
      document.getElementById('cfgTgUrl').value = cfg.tgUrl||'';
      document.getElementById('cfgWa').value = cfg.waNumber||'';
      document.getElementById('cfgPhone').value = cfg.phonePrimary||'';
      document.getElementById('cfgRepo').value = sync.repo||'';
      document.getElementById('cfgBranch').value = sync.branch||'';
      document.getElementById('cfgGitToken').value = sync.token||'';
    } else {
      document.getElementById('adminLogin').hidden = false;
      document.getElementById('adminPanel').hidden = true;
    }
  }

  function renderAdminRooms(){
    var list=document.getElementById('adminRooms');
    list.innerHTML='';
    ROOMS.forEach(function(r){
      var busy = statuses[r.id]==='busy';
      var li=document.createElement('li'); li.className='admin-room';
      li.innerHTML =
        '<span class="admin-name">'+r.label+'</span>' +
        '<b class="admin-chip '+(busy?'busy':'free')+'">'+(busy?'Занят':'Свободен')+'</b>';
      var btn=document.createElement('button');
      btn.type='button'; btn.className='btn ghost admin-toggle';
      btn.textContent = busy?'Освободить':'Занять';
      btn.addEventListener('click',function(){
        statuses[r.id] = busy?'free':'busy';
        saveStatuses(); renderRooms(); renderRoomPicker(); renderAdminRooms();
        maybePushGlobal('✅ Статус обновлён и применён для всего сайта!');
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  document.getElementById('adminLoginBtn').addEventListener('click',function(){
    var pass = document.getElementById('adminPass').value;
    var err = document.getElementById('errAdmin');
    if(pass === ADMIN_PASSWORD){
      adminAuthed = true; localStorage.setItem(AUTH_KEY,'1');
      err.classList.remove('show');
      openAdmin();
    } else {
      err.classList.add('show');
    }
  });

  function readCfgForm(){
    cfg.botToken = document.getElementById('cfgToken').value.trim();
    cfg.chatId = document.getElementById('cfgChat').value.trim();
    cfg.tgUrl = document.getElementById('cfgTgUrl').value.trim() || DEFAULT_CFG.tgUrl;
    cfg.waNumber = document.getElementById('cfgWa').value.trim() || DEFAULT_CFG.waNumber;
    cfg.phonePrimary = document.getElementById('cfgPhone').value.trim() || DEFAULT_CFG.phonePrimary;
    sync.repo = document.getElementById('cfgRepo').value.trim() || DEFAULT_SYNC.repo;
    sync.branch = document.getElementById('cfgBranch').value.trim() || DEFAULT_SYNC.branch;
    sync.token = document.getElementById('cfgGitToken').value.trim();
    saveCfg(); saveSync();
    applyCfgToDom(); renderRooms();
  }
  document.getElementById('adminSaveCfg').addEventListener('click',function(){
    readCfgForm();
    maybePushGlobal('✅ Настройки применены для всего сайта!');
  });

  document.getElementById('adminSaveGlobal').addEventListener('click',function(){
    readCfgForm();
    if(!sync.token){
      adminMsg('⚠️ Укажите GitHub токен — без него изменения видны только в вашем браузере.', 'error', 5000);
      return;
    }
    adminMsg('Синхронизируем с сайтом…', 'info', 0);
    pushSiteData().then(function(){
      adminMsg('✅ Применено для всего сайта! Посетители увидят изменения при обновлении страницы.', 'ok', 5000);
    }).catch(function(err){
      adminMsg('⚠️ Не удалось применить: ' + err.message, 'error', 6000);
    });
  });

  // ---------- ДЕКОРАТИВНЫЕ ПАДАЮЩИЕ ЛЕПЕСТКИ ----------
  (function petals(){
    if(reduce) return;
    var layer = document.getElementById('decoLayer');
    var isSmall = window.innerWidth < 700;
    // статические элементы
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
    // падающие лепестки
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

  // курсор ничего не двигает: параллакс мыши убран

})();
