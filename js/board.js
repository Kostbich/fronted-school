/**
 * board.js — Course Board Controller
 * Маршрут: /course/:id  →  course.html?id=N
 *  Реализует:
 *  - Рендер элементов + SVG-стрелки связей
 *  - Drag & drop перемещение элементов на доске (тьютор)
 *  - Zoom (слайдер + колесо мыши) и Pan (тяни мышью)
 *  - Фильтрация: непросмотренные + диапазон дат обновления
 *  - Миникарта (Canvas overview всех элементов и связей)
 *  - WebSocket синхронизация (auto-reconnect) — ВРЕМЕННО ОТКЛЮЧЕНО,
 *    т.к. на бэкенде отсутствует эндпоинт /ws/course/{id}.
 *    Приложение работает только через HTTP REST API, без real-time обновлений.
 *  - Режим создания связей между элементами
 *  - Модалки просмотра / редактирования / создания элементов
 *  - Публикация / сокрытие курса (тьютор)
 *  - Автосохранение viewport
 *  - Прогресс курса
 *  - Конфетти при 100%
 *  - Keyboard shortcuts
 *  - Живой поиск по элементам
 *  - Анимированный курсор
 *  - Кастомный диалог подтверждения просмотра
 */
(function () {
  'use strict';

  const state = {
    courseId: null,
    board: null,
    me: null,
    isTutor: false,
    zoom: 100,
    panX: 0,
    panY: 0,
    boardDrag: null,
    elDrag: null,
    linkMode: false,
    linkSourceId: null,
    celebrated: false,
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STAGE_W = 3000;
  const STAGE_H = 3000;
  const VIEWPORT_KEY = () => `course:${state.courseId}:viewport`;
  const CELEBRATED_KEY = () => `course:${state.courseId}:celebrated`;

  let dom = {};

  function initDom() {
    const g = id => document.getElementById(id);
    dom = {
      courseTitle: g('courseTitle'),
      boardStage: g('boardStage'),
      boardElements: g('boardElements'),
      boardSvg: g('boardConnections'),
      boardContainer: g('boardContainer'),
      wsStatus: g('wsStatus'),
      zoomSlider: g('zoomSlider'),
      zoomPercent: g('zoomPercent'),
      filterUnviewed: g('filterUnviewed'),
      filterDateFrom: g('filterDateFrom'),
      filterDateTo: g('filterDateTo'),
      btnResetFilters: g('btnResetFilters'),
      btnPublish: g('btnPublish'),
      btnAddElement: g('btnAddElement'),
      btnLinkMode: g('btnLinkMode'),
      btnDeleteConns: g('btnDeleteConnections'),
      minimapCanvas: g('minimapCanvas'),
      minimapViewport: g('minimapViewport'),
      toastContainer: g('toastContainer'),
      boardSearch: g('boardSearch'),
      progressBar: g('courseProgressBar'),
      progressPct: g('courseProgressPct'),
      viewedCount: g('viewedCount'),
      totalCount: g('totalCount'),
    };
  }

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function getCourseId() {
    return parseInt(new URLSearchParams(location.search).get('id'), 10) || null;
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast-msg' + (type ? ' ' + type : '');
    el.textContent = msg;
    dom.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };

  function isTyping() {
    const t = document.activeElement;
    if (!t) return false;
    return ['input','textarea'].includes(t.tagName?.toLowerCase()) || t.isContentEditable;
  }

  function debounce(fn, ms = 300) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ── Custom Confirm Dialog ── */
  function spawnParticles(target) {
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const colors = ['#7b6ef6', '#3ecf8e', '#f5a623', '#f05f7a', '#fff'];
    for (let i = 0; i < 14; i++) {
      const particle = document.createElement('div');
      particle.className = 'confirm-particle';
      const angle = (Math.PI * 2 * i) / 14;
      const distance = 40 + Math.random() * 60;
      particle.style.cssText = `
        left:${cx}px; top:${cy}px; width:6px; height:6px; border-radius:50%;
        background:${colors[i % colors.length]};
        --x:${Math.cos(angle) * distance}px; --y:${Math.sin(angle) * distance - 30}px;
        animation-delay:${i * 0.02}s;
      `;
      document.body.appendChild(particle);
      setTimeout(() => particle.remove(), 900);
    }
  }

  function showConfirmDialog({ icon = '✅', message, sub = '', onYes, onNo }) {
    const old = document.querySelector('.confirm-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <div class="confirm-icon">${icon}</div>
      <div class="confirm-message">${message}</div>
      ${sub ? `<div class="confirm-sub">${sub}</div>` : ''}
      <div class="confirm-buttons">
        <button class="btn-confirm-no">Отмена</button>
        <button class="btn-confirm-yes">Да</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (confirmed) => {
      overlay.style.animation = 'fadeOut .15s ease forwards';
      setTimeout(() => overlay.remove(), 150);
      if (confirmed && onYes) onYes();
      if (!confirmed && onNo) onNo();
    };

    dialog.querySelector('.btn-confirm-yes').addEventListener('click', () => {
      spawnParticles(dialog.querySelector('.confirm-icon'));
      close(true);
    });
    dialog.querySelector('.btn-confirm-no').addEventListener('click', () => close(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  }

  /* ── Storage ── */
  function saveViewport() {
    try { localStorage.setItem(VIEWPORT_KEY(), JSON.stringify({ zoom: state.zoom, panX: state.panX, panY: state.panY })); } catch (_) {}
  }
  function scheduleSaveViewport() {
    clearTimeout(scheduleSaveViewport._t);
    scheduleSaveViewport._t = setTimeout(saveViewport, 600);
  }
  function restoreViewport() {
    try {
      const raw = localStorage.getItem(VIEWPORT_KEY());
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v.zoom === 'number') state.zoom = v.zoom;
        if (typeof v.panX === 'number') state.panX = v.panX;
        if (typeof v.panY === 'number') state.panY = v.panY;
      }
    } catch (_) {}
  }
  function markCelebrated() {
    try { localStorage.setItem(CELEBRATED_KEY(), '1'); state.celebrated = true; } catch (_) {}
  }
  function hasCelebrated() {
    try { return localStorage.getItem(CELEBRATED_KEY()) === '1'; } catch (_) { return state.celebrated; }
  }
  function resetCelebrated() {
    try { localStorage.removeItem(CELEBRATED_KEY()); state.celebrated = false; } catch (_) {}
  }

  /* ── Progress ── */
  function computeProgress() {
    const els = state.board?.elements || [];
    if (!els.length) return { pct: 0, viewed: 0, total: 0 };
    const viewed = els.filter(e => e.viewed).length;
    return { pct: Math.round((viewed / els.length) * 100), viewed, total: els.length };
  }

  function launchConfetti() {
    if (typeof window.confetti === 'function') {
      window.confetti({ particleCount: 160, spread: 72, origin: { y: 0.65 } });
    }
  }

  function updateProgressUI() {
    const { pct } = computeProgress();
    const isComplete = pct === 100;
    const bar = document.getElementById('courseProgressBar');
    if (bar) {
      bar.style.width = pct + '%';
      bar.style.background = isComplete ? '#3ecf8e' : '#7b6ef6';
      bar.style.boxShadow = isComplete ? '0 0 12px rgba(62,207,142,.6)' : '0 0 12px rgba(123,110,246,.6)';
    }
    const pctEl = document.getElementById('courseProgressPct');
    if (pctEl) {
      pctEl.textContent = pct + '%';
      pctEl.style.color = isComplete ? '#3ecf8e' : '';
    }
    const countWrap = document.querySelector('.course-progress-count');
    if (countWrap) countWrap.style.display = 'none';

    // ── WS status dot отключён вместе с WebSocket-подключением ──
    // Раньше здесь принудительно выставлялся "connected" при 100% прогрессе.
    // Сейчас WS не используется вовсе, поэтому индикатор просто остаётся неактивным.
    // if (dom.wsStatus && isComplete) {
    //   dom.wsStatus.className = 'ws-status connected';
    // }

    if (isComplete && !hasCelebrated()) {
      launchConfetti();
      markCelebrated();
    }
    if (!isComplete && hasCelebrated()) {
      resetCelebrated();
    }
  }

  /* ── Search ── */
  function initLiveSearch() {
    if (!dom.boardSearch) return;
    dom.boardSearch.addEventListener('input', debounce(() => {
      const q = dom.boardSearch.value.trim().toLowerCase();
      document.querySelectorAll('.board-element').forEach(node => {
        const id = parseInt(node.dataset.id, 10);
        const el = (state.board.elements || []).find(x => x.id === id);
        if (!el) return;
        const text = [el.title, el.tutor_comment, el.content_url, el.file_url].join(' ').toLowerCase();
        node.style.display = !q || text.includes(q) ? '' : 'none';
      });
      renderConnections();
      updateMinimap();
    }, 300));
  }

  /* ── Keyboard ── */
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', e => {
      if (isTyping()) return;
      if (e.key === 'Escape' && state.linkMode) {
        state.linkMode = false; state.linkSourceId = null;
        document.querySelectorAll('.board-element.link-source').forEach(el => el.classList.remove('link-source'));
        dom.btnLinkMode?.classList?.replace('btn-primary', 'btn-outline-secondary');
        dom.btnLinkMode.textContent = 'Связать';
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); dom.btnLinkMode?.click(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && dom.boardSearch) { e.preventDefault(); dom.boardSearch.focus(); return; }
      if (e.key === '+' || e.key === '=') { state.zoom = Math.min(200, state.zoom + 10); if (dom.zoomSlider) dom.zoomSlider.value = state.zoom; applyTransform(); scheduleSaveViewport(); e.preventDefault(); }
      if (e.key === '-' || e.key === '_') { state.zoom = Math.max(20, state.zoom - 10); if (dom.zoomSlider) dom.zoomSlider.value = state.zoom; applyTransform(); scheduleSaveViewport(); e.preventDefault(); }
    });
  }

  /* ── Cursor ── */
  const cursorState = { x: 0, y: 0, tx: 0, ty: 0, enabled: true };
  function initAnimatedCursor() {
    if (!dom.boardContainer) return;
    let cur = document.getElementById('boardCursor');
    if (!cur) {
      cur = document.createElement('div');
      cur.id = 'boardCursor';
      cur.style.cssText = 'position:absolute;left:0;top:0;width:14px;height:14px;border-radius:999px;background:#7b6ef6;box-shadow:0 0 0 6px rgba(123,110,246,.15);pointer-events:none;transform:translate(-50%,-50%);z-index:50;';
      dom.boardContainer.appendChild(cur);
    }
    dom.boardContainer.addEventListener('pointermove', e => { const r = dom.boardContainer.getBoundingClientRect(); cursorState.tx = e.clientX - r.left; cursorState.ty = e.clientY - r.top; });
    dom.boardContainer.addEventListener('pointerleave', () => { cursorState.enabled = false; if (cur) cur.style.opacity = '0'; });
    dom.boardContainer.addEventListener('pointerenter', () => { cursorState.enabled = true; if (cur) cur.style.opacity = '1'; });
    const tick = () => {
      if (cur && cursorState.enabled) {
        cursorState.x += (cursorState.tx - cursorState.x) * 0.18;
        cursorState.y += (cursorState.ty - cursorState.y) * 0.18;
        cur.style.left = cursorState.x + 'px'; cur.style.top = cursorState.y + 'px';
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ── Filters ── */
  function getFilterClasses(el) {
    const cls = [];
    if (dom.filterUnviewed?.checked && !el.viewed) cls.push('filter-unviewed');
    const from = dom.filterDateFrom?.value;
    const to = dom.filterDateTo?.value;
    if (from && to && el.updated_at) {
      const d = new Date(el.updated_at);
      const df = new Date(from); const dt = new Date(to); dt.setHours(23, 59, 59, 999);
      if (d >= df && d <= dt) cls.push('filter-updated');
    }
    return cls;
  }

  /* ── Build Element ── */
  function buildElementNode(el) {
    const div = document.createElement('div');
    div.className = ['board-element', ...getFilterClasses(el)].join(' ');
    div.dataset.id = el.id;
    div.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.width}px;min-height:${el.height}px;background-color:${el.background_color || '#fff'};border-color:${el.border_color || '#333'};`;

    const title = document.createElement('div'); title.className = 'board-element-title'; title.textContent = el.title;
    const meta = document.createElement('div'); meta.className = 'board-element-meta';
    if (el.created_at) { const s = document.createElement('span'); s.textContent = 'Добавлено: ' + fmtDate(el.created_at); meta.appendChild(s); }
    if (el.updated_at) { const s = document.createElement('span'); s.textContent = 'Обновлено: ' + fmtDate(el.updated_at); meta.appendChild(s); }

    const links = document.createElement('div'); links.className = 'board-element-link';
    if (el.content_url) { const a = document.createElement('a'); a.href = el.content_url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '↗ Контент'; links.appendChild(a); }
    if (el.file_url) { const a = document.createElement('a'); a.href = el.file_url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '↓ Файл'; links.appendChild(a); }

    const viewedLabel = document.createElement('label'); viewedLabel.className = 'board-element-viewed';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!el.viewed;

    chk.addEventListener('change', e => {
      e.stopPropagation();
      const v = chk.checked;
      if (v) {
        const { pct } = computeProgress();
        const remaining = (state.board?.elements || []).filter(x => !x.viewed).length;
        let icon = '✅', message = 'Отметить как пройденный?', sub = '';
        if (remaining === 1) { icon = '🎉'; message = 'Финальный рывок!'; sub = 'Это последний материал. Завершить курс?'; }
        else if (pct >= 80) { icon = '🔥'; message = 'Почти готово!'; sub = `Осталось ${remaining - 1} материал(а). Продолжайте!`; }
        else if (pct >= 50) { icon = '🚀'; message = 'Половина позади!'; sub = 'Двигаемся дальше?'; }
        else { icon = '📚'; message = 'Материал усвоен?'; sub = 'Вы уверены что готовы идти дальше?'; }
        showConfirmDialog({
          icon, message, sub,
          onYes: async () => {
            try {
              await API.setViewed(state.courseId, el.id, true);
              el.viewed = true; chk.checked = true;
              div.classList.remove('filter-unviewed', 'filter-updated');
              getFilterClasses(el).forEach(c => div.classList.add(c));
              updateMinimap(); updateProgressUI();
            } catch (_) { chk.checked = false; }
          },
          onNo: () => { chk.checked = false; }
        });
        chk.checked = false;
        return;
      }
      (async () => {
        try {
          await API.setViewed(state.courseId, el.id, false);
          el.viewed = false;
          div.classList.remove('filter-unviewed', 'filter-updated');
          getFilterClasses(el).forEach(c => div.classList.add(c));
          updateMinimap(); updateProgressUI();
        } catch (_) { chk.checked = true; }
      })();
    });

    const viewedSpan = document.createElement('span'); viewedSpan.textContent = 'Просмотрено';
    viewedLabel.append(chk, viewedSpan);
    div.append(title, meta);
    if (links.children.length) div.appendChild(links);
    div.appendChild(viewedLabel);
    if (el.tutor_comment) {
      const hr = document.createElement('hr'); hr.style.cssText = 'border-color:rgba(0,0,0,.12);margin:8px 0 6px';
      const cmt = document.createElement('div'); cmt.className = 'board-element-comment'; cmt.textContent = '✎ ' + el.tutor_comment;
      div.append(hr, cmt);
    }
    if (state.isTutor) { attachTutorInteraction(div, el); }
    else { div.addEventListener('click', e => { if (e.target.closest('a,input')) return; openElementModal(el, true); }); }
    return div;
  }

  /* ── Tutor Interaction ── */
  function attachTutorInteraction(div, el) {
    div.addEventListener('mousedown', e => {
      if (e.target.closest('a,input,button')) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      state.elDrag = { el, div, startMX: e.clientX, startMY: e.clientY, startElX: el.x, startElY: el.y, moved: false };
    });
    div.addEventListener('click', e => {
      if (e.target.closest('a,input')) return;
      if (state.elDrag?.moved) return;
      if (state.linkMode) { handleLinkClick(el.id, div); return; }
      openElementModal(el, false);
    });
  }

  /* ── Mouse ── */
  function onGlobalMouseMove(e) {
    if (state.elDrag) {
      const { el, div, startMX, startMY, startElX, startElY } = state.elDrag;
      const scale = state.zoom / 100;
      const dx = (e.clientX - startMX) / scale, dy = (e.clientY - startMY) / scale;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) state.elDrag.moved = true;
      el.x = Math.round(startElX + dx); el.y = Math.round(startElY + dy);
      div.style.left = el.x + 'px'; div.style.top = el.y + 'px';
      renderConnections(); updateMinimap();
      return;
    }
    if (state.boardDrag) {
      state.panX = state.boardDrag.startPanX + (e.clientX - state.boardDrag.startX);
      state.panY = state.boardDrag.startPanY + (e.clientY - state.boardDrag.startY);
      applyTransform(); scheduleSaveViewport();
    }
  }
  function onGlobalMouseUp() {
    if (state.elDrag) { const { el, moved } = state.elDrag; state.elDrag = null; if (moved) API.updateElement(state.courseId, el.id, { x: el.x, y: el.y }).catch(() => {}); return; }
    state.boardDrag = null;
  }

  /* ── SVG / Render / Minimap ── */
  function renderConnections() {
    const svg = dom.boardSvg; if (!svg) return; svg.innerHTML = '';
    const conns = state.board?.connections; if (!conns?.length) return;
    svg.setAttribute('viewBox', `0 0 ${STAGE_W} ${STAGE_H}`); svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible';
    const byId = Object.fromEntries((state.board.elements || []).map(e => [e.id, e]));
    const defs = svgEl('defs'); const marker = svgEl('marker', { id: 'arr', markerWidth: 10, markerHeight: 7, refX: 9, refY: 3.5, orient: 'auto' });
    marker.appendChild(svgEl('polygon', { points: '0 0,10 3.5,0 7', fill: '#7b6ef6' })); defs.appendChild(marker); svg.appendChild(defs);
    conns.forEach((c, i) => {
      const from = byId[c.from_element_id], to = byId[c.to_element_id]; if (!from || !to) return;
      const x1 = from.x + from.width / 2, y1 = from.y + (from.height || 120);
      const x2 = to.x + to.width / 2, y2 = to.y, midY = y1 + (y2 - y1) / 2;
      const path = svgEl('path', { d: `M${x1},${y1} L${x1},${midY} L${x2},${midY} L${x2},${y2}`, fill: 'none', stroke: '#7b6ef6', 'stroke-width': 2, 'marker-end': 'url(#arr)' });
      path.style.opacity = '0'; path.style.transition = `opacity .25s ease ${i * 0.04}s`; svg.appendChild(path);
      requestAnimationFrame(() => { path.style.opacity = '1'; });
    });
  }

  function renderBoard() {
    dom.boardElements.innerHTML = '';
    (state.board?.elements || []).forEach(el => dom.boardElements.appendChild(buildElementNode(el)));
    renderConnections(); updateMinimap(); updateProgressUI();
    setTimeout(() => { document.querySelectorAll('.board-element').forEach(el => { if (viewObserver) viewObserver.observe(el); }); }, 0);
  }

  function updateMinimap() {
    const canvas = dom.minimapCanvas; if (!canvas) return;
    const W = canvas.offsetWidth || 180, H = canvas.offsetHeight || 120; canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'), sx = W / STAGE_W, sy = H / STAGE_H;
    ctx.fillStyle = '#0f0f1c'; ctx.fillRect(0, 0, W, H);
    const byId = Object.fromEntries((state.board?.elements || []).map(e => [e.id, e]));
    ctx.strokeStyle = 'rgba(123,110,246,.5)'; ctx.lineWidth = 1;
    (state.board?.connections || []).forEach(c => {
      const f = byId[c.from_element_id], t = byId[c.to_element_id]; if (!f || !t) return;
      ctx.beginPath(); ctx.moveTo((f.x + f.width / 2) * sx, (f.y + (f.height || 120)) * sy); ctx.lineTo((t.x + t.width / 2) * sx, t.y * sy); ctx.stroke();
    });
    (state.board?.elements || []).forEach(el => {
      ctx.fillStyle = el.background_color || '#fff'; ctx.strokeStyle = el.border_color || '#333'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.rect(el.x * sx, el.y * sy, el.width * sx, (el.height || 120) * sy); ctx.fill(); ctx.stroke();
    });
    const scale = state.zoom / 100;
    const vx = (-state.panX / scale) * sx, vy = (-state.panY / scale) * sy;
    const vw = (dom.boardContainer.clientWidth / scale) * sx, vh = (dom.boardContainer.clientHeight / scale) * sy;
    if (dom.minimapViewport) {
      dom.minimapViewport.style.left = Math.max(0, vx) + 'px'; dom.minimapViewport.style.top = Math.max(0, vy) + 'px';
      dom.minimapViewport.style.width = Math.min(W, vw) + 'px'; dom.minimapViewport.style.height = Math.min(H, vh) + 'px';
    }
  }

  function applyTransform() {
    dom.boardStage.style.transform = `translate(${state.panX}px,${state.panY}px) scale(${state.zoom / 100})`;
    dom.zoomPercent.textContent = Math.round(state.zoom) + '%'; updateMinimap();
  }

  /* ── Init UI ── */
  function initZoomPan() {
    if (dom.zoomSlider) { dom.zoomSlider.value = state.zoom; dom.zoomSlider.addEventListener('input', () => { state.zoom = parseInt(dom.zoomSlider.value, 10); applyTransform(); scheduleSaveViewport(); }); }
    dom.boardContainer.addEventListener('wheel', e => { e.preventDefault(); state.zoom = Math.min(200, Math.max(20, state.zoom + (e.deltaY > 0 ? -6 : 6))); dom.zoomSlider.value = state.zoom; applyTransform(); scheduleSaveViewport(); }, { passive: false });
    dom.boardContainer.addEventListener('mousedown', e => { if (e.target.closest('.board-element,.board-minimap')) return; if (e.button !== 0) return; state.boardDrag = { startX: e.clientX, startY: e.clientY, startPanX: state.panX, startPanY: state.panY }; });
    document.addEventListener('mousemove', onGlobalMouseMove); document.addEventListener('mouseup', onGlobalMouseUp);
  }

  function initFilters() {
    [dom.filterUnviewed, dom.filterDateFrom, dom.filterDateTo].forEach(el => el && el.addEventListener('change', renderBoard));
    dom.btnResetFilters?.addEventListener('click', () => { if (dom.filterUnviewed) dom.filterUnviewed.checked = false; if (dom.filterDateFrom) dom.filterDateFrom.value = ''; if (dom.filterDateTo) dom.filterDateTo.value = ''; renderBoard(); toast('Фильтры сброшены'); });
  }

  function initLinkMode() {
    dom.btnLinkMode?.addEventListener('click', () => { state.linkMode = !state.linkMode; state.linkSourceId = null; document.querySelectorAll('.board-element.link-source').forEach(el => el.classList.remove('link-source')); dom.btnLinkMode.classList.toggle('btn-primary', state.linkMode); dom.btnLinkMode.classList.toggle('btn-outline-secondary', !state.linkMode); dom.btnLinkMode.textContent = state.linkMode ? '✕ Отмена' : 'Связать'; });
  }

  function handleLinkClick(id, div) {
    if (!state.linkSourceId) { state.linkSourceId = id; div.classList.add('link-source'); toast('Кликните на второй элемент для связи'); return; }
    if (state.linkSourceId === id) { state.linkSourceId = null; div.classList.remove('link-source'); return; }
    const fromId = state.linkSourceId; state.linkSourceId = null; state.linkMode = false;
    document.querySelectorAll('.board-element.link-source').forEach(el => el.classList.remove('link-source'));
    dom.btnLinkMode.classList.replace('btn-primary', 'btn-outline-secondary'); dom.btnLinkMode.textContent = 'Связать';
    API.createConnection(state.courseId, fromId, id).then(conn => { (state.board.connections = state.board.connections || []).push(conn); renderConnections(); updateMinimap(); toast('Связь добавлена', 'success'); }).catch(err => toast(err.message || 'Ошибка связи', 'error'));
  }

  function initDeleteConns() {
    dom.btnDeleteConns?.addEventListener('click', async () => { if (!confirm('Удалить все связи курса?')) return; try { await API.deleteAllConnections(state.courseId); state.board.connections = []; renderConnections(); updateMinimap(); toast('Все связи удалены'); } catch (err) { toast(err.message || 'Ошибка', 'error'); } });
  }

  function initAddElement() {
    dom.btnAddElement?.addEventListener('click', () => {
      ['newElTitle','newElDescription','newElLinks','newElFiles','newElCustomData'].forEach(id => { const n = document.getElementById(id); if (n) n.value = ''; });
      const scale = state.zoom / 100;
      document.getElementById('newElX').value = Math.max(20, Math.round((-state.panX + dom.boardContainer.clientWidth / 2) / scale - 100));
      document.getElementById('newElY').value = Math.max(20, Math.round((-state.panY + dom.boardContainer.clientHeight / 2) / scale - 60));
      document.getElementById('newElBg').value = '#ffffff'; document.getElementById('newElBorder').value = '#333333';
      new bootstrap.Modal('#modalNewElement').show();
    });
    document.getElementById('btnCreateElement')?.addEventListener('click', async () => {
      const titleEl = document.getElementById('newElTitle'), title = titleEl?.value.trim(); if (!title) { titleEl?.focus(); return; }
      const parseList = raw => raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      let customData = {}; const rawCustom = document.getElementById('newElCustomData')?.value.trim();
      if (rawCustom) { try { customData = JSON.parse(rawCustom); } catch (_) { toast('Ошибка в JSON', 'error'); return; } }
      try {
        const el = await API.createElement(state.courseId, { title, tutor_comment: document.getElementById('newElDescription')?.value.trim(), content_url: parseList(document.getElementById('newElLinks')?.value || '')[0] || '', file_url: parseList(document.getElementById('newElFiles')?.value || '')[0] || '', x: parseFloat(document.getElementById('newElX')?.value) || 100, y: parseFloat(document.getElementById('newElY')?.value) || 100, background_color: document.getElementById('newElBg')?.value || '#ffffff', border_color: document.getElementById('newElBorder')?.value || '#333333', custom_data: customData });
        (state.board.elements = state.board.elements || []).push({ ...el, viewed: false });
        bootstrap.Modal.getInstance('#modalNewElement').hide(); renderBoard(); toast('Материал добавлен', 'success');
      } catch (err) { toast(err.data?.detail || err.message || 'Ошибка создания', 'error'); }
    });
  }

  function openElementModal(el, viewOnly) {
    document.getElementById('modalElementTitle').textContent = el.title;
    const body = document.getElementById('modalElementBody');
    if (viewOnly) {
      body.innerHTML = `<div class="mb-3"><div style="color:var(--text-mid);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Название</div><div style="font-size:15px;font-weight:600">${esc(el.title)}</div></div><div class="row mb-3"><div class="col-6"><div style="color:var(--text-mid);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Добавлено</div><div style="font-family:var(--font-mono);font-size:13px">${fmtDate(el.created_at)}</div></div><div class="col-6"><div style="color:var(--text-mid);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Обновлено</div><div style="font-family:var(--font-mono);font-size:13px">${fmtDate(el.updated_at)}</div></div></div>${el.content_url ? `<div class="mb-2"><a href="${esc(el.content_url)}" target="_blank" class="btn btn-outline-secondary btn-sm">↗ Открыть контент</a></div>` : ''}${el.file_url ? `<div class="mb-2"><a href="${esc(el.file_url)}" target="_blank" class="btn btn-outline-secondary btn-sm">↓ Открыть файл</a></div>` : ''}${el.tutor_comment ? `<div class="mt-3 p-3" style="background:var(--bg-elevated);border-radius:8px;font-size:13px;color:var(--text-mid)">✎ ${esc(el.tutor_comment)}</div>` : ''}`;
      document.getElementById('btnSaveElement').classList.add('d-none'); document.getElementById('btnDeleteElement').classList.add('d-none');
    } else {
      body.innerHTML = `<div class="row"><div class="col-md-6 mb-3"><label class="form-label">Название</label><input type="text" class="form-control" id="editElTitle" value="${esc(el.title)}"></div><div class="col-md-6 mb-3"><label class="form-label">Описание / комментарий</label><textarea class="form-control" id="editElDescription" rows="1">${esc(el.tutor_comment || '')}</textarea></div></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">Ссылки</label><textarea class="form-control" id="editElLinks" rows="2">${esc((el.links || []).join('\n'))}</textarea></div><div class="col-md-6 mb-3"><label class="form-label">Файлы</label><textarea class="form-control" id="editElFiles" rows="2">${esc((el.files || []).join('\n'))}</textarea></div></div><div class="row mb-3"><div class="col-3"><label class="form-label">X</label><input type="number" class="form-control" id="editElX" value="${el.x}"></div><div class="col-3"><label class="form-label">Y</label><input type="number" class="form-control" id="editElY" value="${el.y}"></div><div class="col-3"><label class="form-label">Фон</label><input type="color" class="form-control form-control-color" id="editElBg" value="${el.background_color || '#ffffff'}"></div><div class="col-3"><label class="form-label">Граница</label><input type="color" class="form-control form-control-color" id="editElBorder" value="${el.border_color || '#333333'}"></div></div><div class="mb-3"><label class="form-label">Произвольные поля (JSON)</label><textarea class="form-control" id="editElCustomData" rows="3" style="font-family:var(--font-mono);font-size:12px;">${esc(el.custom_data ? JSON.stringify(el.custom_data, null, 2) : '')}</textarea></div>`;
      document.getElementById('btnSaveElement').classList.remove('d-none'); document.getElementById('btnDeleteElement').classList.remove('d-none');
      document.getElementById('btnSaveElement').onclick = () => saveElement(el); document.getElementById('btnDeleteElement').onclick = () => deleteElement(el);
    }
    new bootstrap.Modal('#modalElement').show();
  }

  async function saveElement(el) {
    const g = id => document.getElementById(id)?.value ?? '';
    const parseList = raw => raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    let customData = {}; try { customData = JSON.parse(g('editElCustomData').trim() || '{}'); } catch (_) { toast('Ошибка в JSON', 'error'); return; }
    try {
      const updated = await API.updateElement(state.courseId, el.id, { title: g('editElTitle').trim() || el.title, tutor_comment: g('editElDescription').trim(), content_url: parseList(g('editElLinks'))[0] || '', file_url: parseList(g('editElFiles'))[0] || '', x: parseFloat(g('editElX')) || el.x, y: parseFloat(g('editElY')) || el.y, background_color: g('editElBg'), border_color: g('editElBorder'), custom_data: customData });
      const idx = state.board.elements.findIndex(e => e.id === el.id); if (idx >= 0) state.board.elements[idx] = { ...updated, viewed: el.viewed };
      bootstrap.Modal.getInstance('#modalElement').hide(); renderBoard(); toast('Сохранено', 'success');
    } catch (err) { toast(err.data?.detail || err.message || 'Ошибка', 'error'); }
  }

  async function deleteElement(el) {
    if (!confirm(`Удалить элемент «${el.title}»?`)) return;
    try { await API.deleteElement(state.courseId, el.id); state.board.elements = state.board.elements.filter(e => e.id !== el.id); bootstrap.Modal.getInstance('#modalElement').hide(); renderBoard(); toast('Элемент удалён'); } catch (err) { toast(err.data?.detail || err.message || 'Ошибка', 'error'); }
  }

  function refreshPublishBtn() { const pub = state.board.course.is_public; dom.btnPublish.textContent = pub ? 'Сделать приватным' : 'Опубликовать'; dom.btnPublish.className = `btn btn-sm ${pub ? 'btn-danger' : 'btn-success'}`; }
  function initPublish() { dom.btnPublish.addEventListener('click', async () => { try { const updated = await API.updateCourse(state.courseId, { is_public: !state.board.course.is_public }); state.board.course = updated; refreshPublishBtn(); toast(updated.is_public ? 'Курс опубликован' : 'Курс скрыт', 'success'); } catch (err) { toast(err.message || 'Ошибка', 'error'); } }); }

  /* ══════════════════════════════════════════════════════
     WEBSOCKET — ВРЕМЕННО ОТКЛЮЧЕНО
     ────────────────────────────────────────────────────
     На текущем бэкенде (wss://diplom-backend-production-fe9d.up.railway.app)
     нет эндпоинта /ws/course/{id}, поэтому попытка подключения
     стабильно завершалась ошибкой и засоряла консоль / вызывала
     "Failed to fetch"-подобные обрывы в логике переподключения.

     Весь нижеописанный код (connectWS / scheduleWsReconnect /
     disconnectWS / handleWsMsg) оставлен как есть и может быть
     включён обратно, как только на бэкенде появится рабочий
     WebSocket-канал — достаточно раскомментировать вызов
     connectWS() в функции init() в самом низу файла.

     Сейчас приложение работает исключительно через REST API
     (api.js): обновления других пользователей не подтягиваются
     в реальном времени, нужен ручной reload страницы.
  ══════════════════════════════════════════════════════ */
  let _ws = null, _wsTimer = null, _wsClosedIntentionally = false;
  function wsSetStatus(s) { if (computeProgress().pct === 100) { dom.wsStatus.className = 'ws-status connected'; return; } dom.wsStatus.className = 'ws-status ' + s; }
  function connectWS() { _wsClosedIntentionally = false; wsSetStatus('reconnecting'); try { _ws = new WebSocket(getWsUrl() + '/ws/course/' + state.courseId); } catch (_) { scheduleWsReconnect(); return; } _ws.onopen = () => { wsSetStatus('connected'); clearTimeout(_wsTimer); _wsTimer = null; }; _ws.onclose = ({ code }) => { _ws = null; wsSetStatus(''); if (!_wsClosedIntentionally && code !== 1000) scheduleWsReconnect(); }; _ws.onerror = () => {}; _ws.onmessage = ({ data }) => { try { handleWsMsg(JSON.parse(data)); } catch (_) {} }; }
  function scheduleWsReconnect() { if (_wsTimer) return; wsSetStatus('reconnecting'); _wsTimer = setTimeout(() => { _wsTimer = null; if (!_wsClosedIntentionally) connectWS(); }, 3000); }
  function disconnectWS() { _wsClosedIntentionally = true; clearTimeout(_wsTimer); if (_ws) { _ws.close(1000); _ws = null; } }
  function handleWsMsg({ type, payload }) { const els = state.board.elements = state.board.elements || []; const conns = state.board.connections = state.board.connections || []; switch (type) { case 'element_added': els.push({ ...payload, viewed: false }); renderBoard(); break; case 'element_updated': { const i = els.findIndex(e => e.id === payload.id); if (i >= 0) els[i] = { ...payload, viewed: els[i].viewed }; renderBoard(); break; } case 'element_removed': state.board.elements = els.filter(e => e.id !== payload.element_id); renderBoard(); break; case 'connection_added': conns.push(payload); renderConnections(); updateMinimap(); break; case 'connection_removed': state.board.connections = conns.filter(c => c.id !== payload.connection_id); renderConnections(); updateMinimap(); break; case 'connections_cleared': state.board.connections = []; renderConnections(); updateMinimap(); break; case 'course_updated': state.board.course = payload; dom.courseTitle.textContent = payload.title; if (state.isTutor) refreshPublishBtn(); break; } }

  let viewObserver = null;
  function initOrResetViewObserver() { if (viewObserver) { viewObserver.disconnect(); viewObserver = null; } if (!window.IntersectionObserver || !dom.boardContainer) return; viewObserver = new IntersectionObserver(() => {}, { root: dom.boardContainer, threshold: [0.6] }); document.querySelectorAll('.board-element').forEach(div => viewObserver.observe(div)); }

  async function init() {
    initDom(); if (!isAuthenticated()) { location.href = 'login.html'; return; }
    state.courseId = getCourseId(); if (!state.courseId) { location.href = 'courses.html'; return; }
    try {
      const [board, me] = await Promise.all([API.getCourseBoard(state.courseId), API.me().catch(() => null)]);
      state.board = board; state.me = me; state.isTutor = !!(me && board.course && board.course.tutor_id === me.id);
      restoreViewport(); dom.courseTitle.textContent = board.course.title; document.title = board.course.title + ' — Nexus Learn';
      if (state.isTutor) { [dom.btnPublish, dom.btnAddElement, dom.btnLinkMode, dom.btnDeleteConns].forEach(el => el && el.classList.remove('d-none')); refreshPublishBtn(); }
      initZoomPan(); initFilters(); initLinkMode(); initDeleteConns(); initAddElement(); initPublish(); initKeyboardShortcuts(); initLiveSearch(); initAnimatedCursor();
      applyTransform(); renderBoard(); initOrResetViewObserver(); updateProgressUI();

      // WebSocket отключён — бэкенд не поддерживает /ws/course/{id}.
      // Раскомментировать строку ниже, когда эндпоинт появится на сервере.
      // connectWS();

      window.addEventListener('beforeunload', disconnectWS);
    } catch (err) { if (err.status === 403) location.href = '403.html'; else if (err.status === 401) { clearToken(); location.href = 'login.html'; } else if (err.status === 404) { toast('Курс не найден', 'error'); setTimeout(() => { location.href = 'courses.html'; }, 2000); } else { location.href = 'courses.html'; } }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
