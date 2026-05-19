/**
 * board.js — Course Board Controller
 * Маршрут: /course/:id  →  course.html?id=N
 *
 * Реализует:
 *  - Рендер элементов + SVG-стрелки связей
 *  - Drag & drop перемещение элементов на доске (тьютор)
 *  - Zoom (слайдер + колесо мыши) и Pan (тяни мышью)
 *  - Фильтрация: непросмотренные + диапазон дат обновления
 *  - Миникарта (Canvas overview всех элементов и связей)
 *  - WebSocket синхронизация (авто-переподключение)
 *  - Режим создания связей между элементами
 *  - Модалки просмотра / редактирования / создания элементов
 *  - Публикация / сокрытие курса (тьютор)
 */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════════════ */
  const state = {
    courseId: null,
    board:    null,     // { course, elements[], connections[] }
    me:       null,
    isTutor:  false,

    zoom: 100,          // %
    panX: 0,
    panY: 0,

    boardDrag: null,    // pan: { startX, startY, startPanX, startPanY }
    elDrag:    null,    // element move: { el, div, startMX, startMY, startElX, startElY, moved }

    linkMode:     false,
    linkSourceId: null,
  };

  const SVG_NS  = 'http://www.w3.org/2000/svg';
  const STAGE_W = 3000;
  const STAGE_H = 3000;

  /* ══════════════════════════════════════════════════════
     DOM — resolved once on DOMContentLoaded
  ══════════════════════════════════════════════════════ */
  let dom = {};

  function initDom() {
    const g = id => document.getElementById(id);
    dom = {
      courseTitle:    g('courseTitle'),
      boardStage:     g('boardStage'),
      boardElements:  g('boardElements'),
      boardSvg:       g('boardConnections'),
      boardContainer: g('boardContainer'),
      wsStatus:       g('wsStatus'),
      zoomSlider:     g('zoomSlider'),
      zoomPercent:    g('zoomPercent'),
      filterUnviewed: g('filterUnviewed'),
      filterDateFrom: g('filterDateFrom'),
      filterDateTo:   g('filterDateTo'),
      btnResetFilters:g('btnResetFilters'),
      btnPublish:     g('btnPublish'),
      btnAddElement:  g('btnAddElement'),
      btnLinkMode:    g('btnLinkMode'),
      btnDeleteConns: g('btnDeleteConnections'),
      minimapCanvas:  g('minimapCanvas'),
      minimapViewport:g('minimapViewport'),
      toastContainer: g('toastContainer'),
    };
  }

  /* ══════════════════════════════════════════════════════
     UTILS
  ══════════════════════════════════════════════════════ */
  const esc = s => String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' +
           d.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
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
    Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
    return el;
  };

  /* ══════════════════════════════════════════════════════
     FILTER HELPERS
  ══════════════════════════════════════════════════════ */
  function getFilterClasses(el) {
    const cls = [];
    if (dom.filterUnviewed.checked && !el.viewed) cls.push('filter-unviewed');
    const from = dom.filterDateFrom.value;
    const to   = dom.filterDateTo.value;
    if (from && to && el.updated_at) {
      const d  = new Date(el.updated_at);
      const df = new Date(from);
      const dt = new Date(to); dt.setHours(23,59,59,999);
      if (d >= df && d <= dt) cls.push('filter-updated');
    }
    return cls;
  }

  /* ══════════════════════════════════════════════════════
     BUILD ELEMENT NODE
  ══════════════════════════════════════════════════════ */
  function buildElementNode(el) {
    const div = document.createElement('div');
    div.className = ['board-element', ...getFilterClasses(el)].join(' ');
    div.dataset.id = el.id;
    div.style.cssText = [
      `left:${el.x}px`, `top:${el.y}px`,
      `width:${el.width}px`, `min-height:${el.height}px`,
      `background-color:${el.background_color || '#fff'}`,
      `border-color:${el.border_color || '#333'}`,
    ].join(';');

    /* Title */
    const title = document.createElement('div');
    title.className   = 'board-element-title';
    title.textContent = el.title;

    /* Meta dates */
    const meta = document.createElement('div');
    meta.className = 'board-element-meta';
    if (el.created_at) {
      const s = document.createElement('span');
      s.textContent = 'Добавлено: ' + fmtDate(el.created_at);
      meta.appendChild(s);
    }
    if (el.updated_at) {
      const s = document.createElement('span');
      s.textContent = 'Обновлено: ' + fmtDate(el.updated_at);
      meta.appendChild(s);
    }

    /* Links */
    const links = document.createElement('div');
    links.className = 'board-element-link';
    if (el.content_url) {
      const a = document.createElement('a');
      a.href = el.content_url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = '↗ Контент';
      links.appendChild(a);
    }
    if (el.file_url) {
      const a = document.createElement('a');
      a.href = el.file_url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = '↓ Файл';
      links.appendChild(a);
    }

    /* Viewed checkbox */
    const viewedLabel = document.createElement('label');
    viewedLabel.className = 'board-element-viewed';
    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = !!el.viewed;
    chk.addEventListener('change', async (e) => {
      e.stopPropagation();
      const v = chk.checked;
      try {
        await API.setViewed(state.courseId, el.id, v);
        el.viewed = v;
        div.classList.remove('filter-unviewed','filter-updated');
        getFilterClasses(el).forEach(c => div.classList.add(c));
        updateMinimap();
      } catch (_) { chk.checked = !v; }
    });
    const viewedSpan = document.createElement('span');
    viewedSpan.textContent = 'Просмотрено';
    viewedLabel.append(chk, viewedSpan);

    div.append(title, meta);
    if (links.children.length) div.appendChild(links);
    div.appendChild(viewedLabel);

    /* Tutor comment */
    if (el.tutor_comment) {
      const hr = document.createElement('hr');
      hr.style.cssText = 'border-color:rgba(0,0,0,.12);margin:8px 0 6px';
      const cmt = document.createElement('div');
      cmt.className   = 'board-element-comment';
      cmt.textContent = '✎ ' + el.tutor_comment;
      div.append(hr, cmt);
    }

    /* Events */
    if (state.isTutor) {
      attachTutorInteraction(div, el);
    } else {
      div.addEventListener('click', e => {
        if (e.target.closest('a,input')) return;
        openElementModal(el, true);
      });
    }

    return div;
  }

  /* ══════════════════════════════════════════════════════
     TUTOR INTERACTION — drag to move + click to open
  ══════════════════════════════════════════════════════ */
  function attachTutorInteraction(div, el) {
    div.addEventListener('mousedown', e => {
      if (e.target.closest('a,input,button')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.elDrag = {
        el, div,
        startMX: e.clientX, startMY: e.clientY,
        startElX: el.x,    startElY: el.y,
        moved: false,
      };
    });

    div.addEventListener('click', e => {
      if (e.target.closest('a,input')) return;
      if (state.elDrag?.moved) return; // was a drag
      if (state.linkMode) { handleLinkClick(el.id, div); return; }
      openElementModal(el, false);
    });
  }

  /* ══════════════════════════════════════════════════════
     GLOBAL MOUSE — element drag + board pan
  ══════════════════════════════════════════════════════ */
  function onGlobalMouseMove(e) {
    /* Element drag */
    if (state.elDrag) {
      const { el, div, startMX, startMY, startElX, startElY } = state.elDrag;
      const scale = state.zoom / 100;
      const dx = (e.clientX - startMX) / scale;
      const dy = (e.clientY - startMY) / scale;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) state.elDrag.moved = true;
      el.x = Math.round(startElX + dx);
      el.y = Math.round(startElY + dy);
      div.style.left = el.x + 'px';
      div.style.top  = el.y + 'px';
      renderConnections();
      updateMinimap();
      return;
    }

    /* Board pan */
    if (state.boardDrag) {
      state.panX = state.boardDrag.startPanX + (e.clientX - state.boardDrag.startX);
      state.panY = state.boardDrag.startPanY + (e.clientY - state.boardDrag.startY);
      applyTransform();
    }
  }

  function onGlobalMouseUp() {
    /* Save element position after drag */
    if (state.elDrag) {
      const { el, moved } = state.elDrag;
      state.elDrag = null;
      if (moved) {
        API.updateElement(state.courseId, el.id, { x: el.x, y: el.y })
          .catch(() => toast('Не удалось сохранить позицию', 'error'));
      }
      return;
    }
    state.boardDrag = null;
  }

  /* ══════════════════════════════════════════════════════
     SVG CONNECTIONS
  ══════════════════════════════════════════════════════ */
  function renderConnections() {
    const svg = dom.boardSvg;
    svg.innerHTML = '';

    const conns = state.board?.connections;
    if (!conns?.length) return;

    svg.setAttribute('viewBox', `0 0 ${STAGE_W} ${STAGE_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible';

    const byId = Object.fromEntries((state.board.elements || []).map(e => [e.id, e]));

    /* Arrow marker */
    const defs   = svgEl('defs');
    const marker = svgEl('marker', { id:'arr', markerWidth:10, markerHeight:7, refX:9, refY:3.5, orient:'auto' });
    marker.appendChild(svgEl('polygon', { points:'0 0,10 3.5,0 7', fill:'#7b6ef6' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    conns.forEach((c, i) => {
      const from = byId[c.from_element_id];
      const to   = byId[c.to_element_id];
      if (!from || !to) return;

      const x1   = from.x + from.width / 2;
      const y1   = from.y + (from.height || 120);
      const x2   = to.x   + to.width   / 2;
      const y2   = to.y;
      const midY = y1 + (y2 - y1) / 2;

      const path = svgEl('path', {
        d: `M${x1},${y1} L${x1},${midY} L${x2},${midY} L${x2},${y2}`,
        fill: 'none', stroke: '#7b6ef6', 'stroke-width': 2,
        'marker-end': 'url(#arr)',
      });
      path.style.opacity    = '0';
      path.style.transition = `opacity .25s ease ${i * 0.04}s`;
      svg.appendChild(path);
      requestAnimationFrame(() => { path.style.opacity = '1'; });
    });
  }

  /* ══════════════════════════════════════════════════════
     FULL BOARD RENDER
  ══════════════════════════════════════════════════════ */
  function renderBoard() {
    dom.boardElements.innerHTML = '';
    (state.board?.elements || []).forEach(el => {
      dom.boardElements.appendChild(buildElementNode(el));
    });
    renderConnections();
    updateMinimap();
  }

  /* ══════════════════════════════════════════════════════
     MINIMAP
  ══════════════════════════════════════════════════════ */
  function updateMinimap() {
    const canvas = dom.minimapCanvas;
    if (!canvas) return;
    const W = canvas.offsetWidth  || 180;
    const H = canvas.offsetHeight || 120;
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const sx = W / STAGE_W, sy = H / STAGE_H;

    ctx.fillStyle = '#0f0f1c';
    ctx.fillRect(0, 0, W, H);

    const byId = Object.fromEntries((state.board?.elements || []).map(e => [e.id, e]));

    /* Connections */
    ctx.strokeStyle = 'rgba(123,110,246,.5)';
    ctx.lineWidth   = 1;
    (state.board?.connections || []).forEach(c => {
      const f = byId[c.from_element_id], t = byId[c.to_element_id];
      if (!f || !t) return;
      ctx.beginPath();
      ctx.moveTo((f.x + f.width/2)*sx, (f.y+(f.height||120))*sy);
      ctx.lineTo((t.x + t.width/2)*sx,  t.y*sy);
      ctx.stroke();
    });

    /* Elements */
    (state.board?.elements || []).forEach(el => {
      ctx.fillStyle   = el.background_color || '#fff';
      ctx.strokeStyle = el.border_color     || '#333';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.rect(el.x*sx, el.y*sy, el.width*sx, (el.height||120)*sy);
      ctx.fill(); ctx.stroke();
    });

    /* Viewport indicator */
    const scale = state.zoom / 100;
    const vx = (-state.panX / scale) * sx;
    const vy = (-state.panY / scale) * sy;
    const vw = (dom.boardContainer.clientWidth  / scale) * sx;
    const vh = (dom.boardContainer.clientHeight / scale) * sy;
    if (dom.minimapViewport) {
      dom.minimapViewport.style.left   = Math.max(0, vx) + 'px';
      dom.minimapViewport.style.top    = Math.max(0, vy) + 'px';
      dom.minimapViewport.style.width  = Math.min(W, vw) + 'px';
      dom.minimapViewport.style.height = Math.min(H, vh) + 'px';
    }
  }

  /* ══════════════════════════════════════════════════════
     TRANSFORM (zoom + pan)
  ══════════════════════════════════════════════════════ */
  function applyTransform() {
    dom.boardStage.style.transform =
      `translate(${state.panX}px,${state.panY}px) scale(${state.zoom/100})`;
    dom.zoomPercent.textContent = Math.round(state.zoom) + '%';
    updateMinimap();
  }

  /* ══════════════════════════════════════════════════════
     INIT: zoom / pan listeners
  ══════════════════════════════════════════════════════ */
  function initZoomPan() {
    dom.zoomSlider.value = state.zoom;
    dom.zoomSlider.addEventListener('input', () => {
      state.zoom = parseInt(dom.zoomSlider.value, 10);
      applyTransform();
    });

    dom.boardContainer.addEventListener('wheel', e => {
      e.preventDefault();
      state.zoom = Math.min(200, Math.max(20, state.zoom + (e.deltaY > 0 ? -6 : 6)));
      dom.zoomSlider.value = state.zoom;
      applyTransform();
    }, { passive: false });

    dom.boardContainer.addEventListener('mousedown', e => {
      if (e.target.closest('.board-element,.board-minimap')) return;
      if (e.button !== 0) return;
      state.boardDrag = { startX:e.clientX, startY:e.clientY, startPanX:state.panX, startPanY:state.panY };
    });

    document.addEventListener('mousemove', onGlobalMouseMove);
    document.addEventListener('mouseup',   onGlobalMouseUp);
  }

  /* ══════════════════════════════════════════════════════
     INIT: filters
  ══════════════════════════════════════════════════════ */
  function initFilters() {
    [dom.filterUnviewed, dom.filterDateFrom, dom.filterDateTo]
      .forEach(el => el.addEventListener('change', renderBoard));

    dom.btnResetFilters.addEventListener('click', () => {
      dom.filterUnviewed.checked = false;
      dom.filterDateFrom.value   = '';
      dom.filterDateTo.value     = '';
      renderBoard();
      toast('Фильтры сброшены');
    });
  }

  /* ══════════════════════════════════════════════════════
     INIT: link mode
  ══════════════════════════════════════════════════════ */
  function initLinkMode() {
    dom.btnLinkMode.addEventListener('click', () => {
      state.linkMode     = !state.linkMode;
      state.linkSourceId = null;
      document.querySelectorAll('.board-element.link-source')
        .forEach(el => el.classList.remove('link-source'));
      dom.btnLinkMode.classList.toggle('btn-primary',           state.linkMode);
      dom.btnLinkMode.classList.toggle('btn-outline-secondary', !state.linkMode);
      dom.btnLinkMode.textContent = state.linkMode ? '✕ Отмена' : 'Связать';
    });
  }

  function handleLinkClick(id, div) {
    if (!state.linkSourceId) {
      state.linkSourceId = id;
      div.classList.add('link-source');
      toast('Кликните на второй элемент для связи');
      return;
    }
    if (state.linkSourceId === id) {
      state.linkSourceId = null;
      div.classList.remove('link-source');
      return;
    }
    const fromId = state.linkSourceId;
    // reset
    state.linkSourceId = null;
    state.linkMode     = false;
    document.querySelectorAll('.board-element.link-source')
      .forEach(el => el.classList.remove('link-source'));
    dom.btnLinkMode.classList.replace('btn-primary','btn-outline-secondary');
    dom.btnLinkMode.textContent = 'Связать';

    API.createConnection(state.courseId, fromId, id)
      .then(conn => {
        (state.board.connections = state.board.connections || []).push(conn);
        renderConnections(); updateMinimap();
        toast('Связь добавлена', 'success');
      })
      .catch(err => toast(err.message || 'Ошибка связи', 'error'));
  }

  /* ══════════════════════════════════════════════════════
     INIT: delete all connections
  ══════════════════════════════════════════════════════ */
  function initDeleteConns() {
    dom.btnDeleteConns.addEventListener('click', async () => {
      if (!confirm('Удалить все связи курса?')) return;
      try {
        await API.deleteAllConnections(state.courseId);
        state.board.connections = [];
        renderConnections(); updateMinimap();
        toast('Все связи удалены');
      } catch (err) {
        toast(err.message || 'Ошибка', 'error');
      }
    });
  }

  /* ══════════════════════════════════════════════════════
     INIT: add element
  ══════════════════════════════════════════════════════ */
  function initAddElement() {
    dom.btnAddElement.addEventListener('click', () => {
      ['newElTitle','newElContentUrl','newElFileUrl','newElComment']
        .forEach(id => { document.getElementById(id).value = ''; });

      // Place in visible center
      const scale = state.zoom / 100;
      const cx = Math.round((-state.panX + dom.boardContainer.clientWidth  / 2) / scale - 100);
      const cy = Math.round((-state.panY + dom.boardContainer.clientHeight / 2) / scale - 60);
      document.getElementById('newElX').value      = Math.max(20, cx);
      document.getElementById('newElY').value      = Math.max(20, cy);
      document.getElementById('newElBg').value     = '#ffffff';
      document.getElementById('newElBorder').value = '#333333';
      new bootstrap.Modal('#modalNewElement').show();
    });

    document.getElementById('btnCreateElement').addEventListener('click', async () => {
      const title = document.getElementById('newElTitle').value.trim();
      if (!title) { document.getElementById('newElTitle').focus(); return; }
      try {
        const el = await API.createElement(state.courseId, {
          title,
          content_url:      document.getElementById('newElContentUrl').value.trim(),
          file_url:         document.getElementById('newElFileUrl').value.trim(),
          tutor_comment:    document.getElementById('newElComment').value.trim(),
          x:                parseFloat(document.getElementById('newElX').value) || 100,
          y:                parseFloat(document.getElementById('newElY').value) || 100,
          background_color: document.getElementById('newElBg').value,
          border_color:     document.getElementById('newElBorder').value,
        });
        (state.board.elements = state.board.elements || []).push({ ...el, viewed: false });
        bootstrap.Modal.getInstance('#modalNewElement').hide();
        renderBoard();
        toast('Элемент добавлен', 'success');
      } catch (err) {
        toast(err.data?.detail || err.message || 'Ошибка создания', 'error');
      }
    });
  }

  /* ══════════════════════════════════════════════════════
     ELEMENT MODAL
  ══════════════════════════════════════════════════════ */
  function openElementModal(el, viewOnly) {
    document.getElementById('modalElementTitle').textContent = el.title;
    const body = document.getElementById('modalElementBody');

    if (viewOnly) {
      body.innerHTML = `
        <div class="mb-3">
          <div style="color:var(--text-mid);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Название</div>
          <div style="font-size:15px;font-weight:600">${esc(el.title)}</div>
        </div>
        <div class="row mb-3">
          <div class="col-6">
            <div style="color:var(--text-mid);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Добавлено</div>
            <div style="font-family:var(--font-mono);font-size:13px">${fmtDate(el.created_at)}</div>
          </div>
          <div class="col-6">
            <div style="color:var(--text-mid);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Обновлено</div>
            <div style="font-family:var(--font-mono);font-size:13px">${fmtDate(el.updated_at)}</div>
          </div>
        </div>
        ${el.content_url ? `<div class="mb-2"><a href="${esc(el.content_url)}" target="_blank" class="btn btn-outline-secondary btn-sm">↗ Открыть контент</a></div>` : ''}
        ${el.file_url    ? `<div class="mb-2"><a href="${esc(el.file_url)}"    target="_blank" class="btn btn-outline-secondary btn-sm">↓ Открыть файл</a></div>`    : ''}
        ${el.tutor_comment ? `<div class="mt-3 p-3" style="background:var(--bg-elevated);border-radius:8px;font-size:13px;color:var(--text-mid)">✎ ${esc(el.tutor_comment)}</div>` : ''}
      `;
      document.getElementById('btnSaveElement').classList.add('d-none');
      document.getElementById('btnDeleteElement').classList.add('d-none');
    } else {
      body.innerHTML = `
        <div class="mb-2"><label class="form-label">Название</label>
          <input type="text" class="form-control" id="editElTitle" value="${esc(el.title)}"></div>
        <div class="mb-2"><label class="form-label">Ссылка на контент</label>
          <input type="url" class="form-control" id="editElContentUrl" value="${esc(el.content_url||'')}"></div>
        <div class="mb-2"><label class="form-label">Ссылка на файл</label>
          <input type="url" class="form-control" id="editElFileUrl" value="${esc(el.file_url||'')}"></div>
        <div class="mb-2"><label class="form-label">Комментарий тьютора</label>
          <input type="text" class="form-control" id="editElComment" value="${esc(el.tutor_comment||'')}"></div>
        <div class="row mb-2">
          <div class="col-3"><label class="form-label">X</label>
            <input type="number" class="form-control" id="editElX" value="${el.x}"></div>
          <div class="col-3"><label class="form-label">Y</label>
            <input type="number" class="form-control" id="editElY" value="${el.y}"></div>
          <div class="col-3"><label class="form-label">Ширина</label>
            <input type="number" class="form-control" id="editElW" value="${el.width}"></div>
          <div class="col-3"><label class="form-label">Высота</label>
            <input type="number" class="form-control" id="editElH" value="${el.height}"></div>
        </div>
        <div class="row mb-2">
          <div class="col-6"><label class="form-label">Цвет фона</label>
            <input type="color" class="form-control form-control-color" id="editElBg" value="${el.background_color||'#ffffff'}"></div>
          <div class="col-6"><label class="form-label">Цвет границы</label>
            <input type="color" class="form-control form-control-color" id="editElBorder" value="${el.border_color||'#333333'}"></div>
        </div>
      `;
      document.getElementById('btnSaveElement').classList.remove('d-none');
      document.getElementById('btnDeleteElement').classList.remove('d-none');
      document.getElementById('btnSaveElement').onclick   = () => saveElement(el);
      document.getElementById('btnDeleteElement').onclick = () => deleteElement(el);
    }

    new bootstrap.Modal('#modalElement').show();
  }

  async function saveElement(el) {
    const g = id => document.getElementById(id)?.value ?? '';
    const data = {
      title:            g('editElTitle').trim() || el.title,
      content_url:      g('editElContentUrl').trim(),
      file_url:         g('editElFileUrl').trim(),
      tutor_comment:    g('editElComment').trim(),
      x:                parseFloat(g('editElX')) || el.x,
      y:                parseFloat(g('editElY')) || el.y,
      width:            parseFloat(g('editElW')) || el.width,
      height:           parseFloat(g('editElH')) || el.height,
      background_color: g('editElBg'),
      border_color:     g('editElBorder'),
    };
    try {
      const updated = await API.updateElement(state.courseId, el.id, data);
      const idx = state.board.elements.findIndex(e => e.id === el.id);
      if (idx >= 0) state.board.elements[idx] = { ...updated, viewed: el.viewed };
      bootstrap.Modal.getInstance('#modalElement').hide();
      renderBoard();
      toast('Сохранено', 'success');
    } catch (err) {
      toast(err.data?.detail || err.message || 'Ошибка', 'error');
    }
  }

  async function deleteElement(el) {
    if (!confirm(`Удалить элемент «${el.title}»?`)) return;
    try {
      await API.deleteElement(state.courseId, el.id);
      state.board.elements = state.board.elements.filter(e => e.id !== el.id);
      bootstrap.Modal.getInstance('#modalElement').hide();
      renderBoard();
      toast('Элемент удалён');
    } catch (err) {
      toast(err.data?.detail || err.message || 'Ошибка', 'error');
    }
  }

  /* ══════════════════════════════════════════════════════
     PUBLISH BUTTON
  ══════════════════════════════════════════════════════ */
  function refreshPublishBtn() {
    const pub = state.board.course.is_public;
    dom.btnPublish.textContent = pub ? 'Сделать приватным' : 'Опубликовать';
    dom.btnPublish.className   = `btn btn-sm ${pub ? 'btn-danger' : 'btn-success'}`;
  }

  function initPublish() {
    dom.btnPublish.addEventListener('click', async () => {
      try {
        const updated = await API.updateCourse(state.courseId, { is_public: !state.board.course.is_public });
        state.board.course = updated;
        refreshPublishBtn();
        toast(updated.is_public ? 'Курс опубликован' : 'Курс скрыт', 'success');
      } catch (err) {
        toast(err.message || 'Ошибка', 'error');
      }
    });
  }

  /* ══════════════════════════════════════════════════════
     WEBSOCKET
  ══════════════════════════════════════════════════════ */
  let _ws = null, _wsTimer = null, _wsClosedIntentionally = false;

  function wsSetStatus(s) { dom.wsStatus.className = 'ws-status ' + s; }

  function connectWS() {
    _wsClosedIntentionally = false;
    wsSetStatus('reconnecting');
    try { _ws = new WebSocket(getWsUrl() + '/ws/course/' + state.courseId); }
    catch (_) { scheduleWsReconnect(); return; }

    _ws.onopen  = () => { wsSetStatus('connected'); clearTimeout(_wsTimer); _wsTimer = null; };
    _ws.onclose = ({ code }) => {
      _ws = null; wsSetStatus('');
      if (!_wsClosedIntentionally && code !== 1000) scheduleWsReconnect();
    };
    _ws.onerror = () => {};
    _ws.onmessage = ({ data }) => {
      try { handleWsMsg(JSON.parse(data)); } catch (_) {}
    };
  }

  function scheduleWsReconnect() {
    if (_wsTimer) return;
    wsSetStatus('reconnecting');
    _wsTimer = setTimeout(() => { _wsTimer = null; if (!_wsClosedIntentionally) connectWS(); }, 3000);
  }

  function disconnectWS() {
    _wsClosedIntentionally = true;
    clearTimeout(_wsTimer);
    if (_ws) { _ws.close(1000); _ws = null; }
  }

  function handleWsMsg({ type, payload }) {
    const els   = state.board.elements    = state.board.elements    || [];
    const conns = state.board.connections = state.board.connections || [];
    switch (type) {
      case 'element_added':
        els.push({ ...payload, viewed: false }); renderBoard(); break;
      case 'element_updated': {
        const i = els.findIndex(e => e.id === payload.id);
        if (i >= 0) els[i] = { ...payload, viewed: els[i].viewed };
        renderBoard(); break;
      }
      case 'element_removed':
        state.board.elements = els.filter(e => e.id !== payload.element_id); renderBoard(); break;
      case 'connection_added':
        conns.push(payload); renderConnections(); updateMinimap(); break;
      case 'connection_removed':
        state.board.connections = conns.filter(c => c.id !== payload.connection_id);
        renderConnections(); updateMinimap(); break;
      case 'connections_cleared':
        state.board.connections = []; renderConnections(); updateMinimap(); break;
      case 'course_updated':
        state.board.course = payload;
        dom.courseTitle.textContent = payload.title;
        if (state.isTutor) refreshPublishBtn(); break;
    }
  }

  /* ══════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════ */
  async function init() {
    initDom();

    if (!isAuthenticated()) { location.href = 'login.html'; return; }

    state.courseId = getCourseId();
    if (!state.courseId) { location.href = 'courses.html'; return; }

    try {
      const [board, me] = await Promise.all([
        API.getCourseBoard(state.courseId),
        API.me().catch(() => null),
      ]);

      state.board   = board;
      state.me      = me;
      state.isTutor = !!(me && board.course && board.course.tutor_id === me.id);

      dom.courseTitle.textContent = board.course.title;
      document.title = board.course.title + ' — Nexus Learn';

      if (state.isTutor) {
        [dom.btnPublish, dom.btnAddElement, dom.btnLinkMode, dom.btnDeleteConns]
          .forEach(el => el.classList.remove('d-none'));
        refreshPublishBtn();
      }

      initZoomPan();
      initFilters();
      initLinkMode();
      initDeleteConns();
      initAddElement();
      initPublish();
      applyTransform();
      renderBoard();
      connectWS();
      window.addEventListener('beforeunload', disconnectWS);

    } catch (err) {
      if (err.status === 403)       location.href = '403.html';
      else if (err.status === 401)  { clearToken(); location.href = 'login.html'; }
      else if (err.status === 404)  { toast('Курс не найден', 'error'); setTimeout(() => { location.href = 'courses.html'; }, 2000); }
      else                          location.href = 'courses.html';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
