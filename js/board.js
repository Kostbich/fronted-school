/**
 * board.js — Course Board Controller
 * Handles rendering, WebSocket sync, filters, zoom/pan, minimap
 */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════ */
  const state = {
    courseId: null,
    board: null,        // { course, elements[], connections[] }
    me: null,
    isTutor: false,

    zoom: 100,          // percent
    panX: 0,
    panY: 0,

    linkMode: false,
    linkSourceId: null,

    drag: null,         // { startX, startY, startPanX, startPanY }
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ══════════════════════════════════════════════
     DOM REFS
  ══════════════════════════════════════════════ */
  const $ = id => document.getElementById(id);
  const dom = {
    courseTitle:        $('courseTitle'),
    boardStage:         $('boardStage'),
    boardElements:      $('boardElements'),
    boardConnections:   $('boardConnections'),
    boardContainer:     $('boardContainer'),
    wsStatus:           $('wsStatus'),
    zoomSlider:         $('zoomSlider'),
    zoomPercent:        $('zoomPercent'),
    filterUnviewed:     $('filterUnviewed'),
    filterDateFrom:     $('filterDateFrom'),
    filterDateTo:       $('filterDateTo'),
    btnPublish:         $('btnPublish'),
    btnAddElement:      $('btnAddElement'),
    btnLinkMode:        $('btnLinkMode'),
    btnDeleteConns:     $('btnDeleteConnections'),
    btnResetFilters:    $('btnResetFilters'),
    minimapCanvas:      $('minimapCanvas'),
    minimapViewport:    $('minimapViewport'),
    toastContainer:     $('toastContainer'),
  };

  /* ══════════════════════════════════════════════
     UTILITIES
  ══════════════════════════════════════════════ */
  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

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

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  /* ══════════════════════════════════════════════
     FILTER HELPERS
  ══════════════════════════════════════════════ */
  function getFilterClasses(el) {
    const unviewedOn = dom.filterUnviewed.checked;
    const from = dom.filterDateFrom.value;
    const to   = dom.filterDateTo.value;

    const isUnviewed = !el.viewed;
    let inRange = false;
    if (from && to && el.updated_at) {
      const d = new Date(el.updated_at);
      const df = new Date(from);
      const dt = new Date(to);
      dt.setHours(23, 59, 59, 999);
      inRange = d >= df && d <= dt;
    }

    const classes = [];
    if (unviewedOn && isUnviewed) classes.push('filter-unviewed');
    if (from && to && inRange)    classes.push('filter-updated');
    return classes;
  }

  /* ══════════════════════════════════════════════
     ELEMENT RENDERING
  ══════════════════════════════════════════════ */
  function buildElementNode(el) {
    const filterClasses = getFilterClasses(el).join(' ');
    const div = document.createElement('div');
    div.className = 'board-element' + (filterClasses ? ' ' + filterClasses : '');
    div.dataset.id = el.id;
    div.style.cssText = [
      `left:${el.x}px`,
      `top:${el.y}px`,
      `width:${el.width}px`,
      `min-height:${el.height}px`,
      `background-color:${el.background_color || '#fff'}`,
      `border-color:${el.border_color || '#333'}`,
    ].join(';');

    /* Title */
    const title = document.createElement('div');
    title.className = 'board-element-title';
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
    chk.type = 'checkbox';
    chk.checked = !!el.viewed;
    chk.addEventListener('change', async (e) => {
      e.stopPropagation();
      const v = chk.checked;
      try {
        await API.setViewed(state.courseId, el.id, v);
        el.viewed = v;
        // Update filter classes without full re-render
        const fc = getFilterClasses(el);
        div.classList.remove('filter-unviewed', 'filter-updated');
        fc.forEach(c => div.classList.add(c));
        updateMinimap();
      } catch (_) {
        chk.checked = !v; // revert
      }
    });
    viewedLabel.appendChild(chk);
    const viewedText = document.createElement('span');
    viewedText.textContent = 'Просмотрено';
    viewedLabel.appendChild(viewedText);

    div.appendChild(title);
    div.appendChild(meta);
    if (links.children.length) div.appendChild(links);
    div.appendChild(viewedLabel);

    /* Tutor comment */
    if (el.tutor_comment) {
      const hr = document.createElement('hr');
      hr.style.cssText = 'border-color:rgba(0,0,0,.1);margin:8px 0 6px';
      const comment = document.createElement('div');
      comment.className = 'board-element-comment';
      comment.textContent = '✎ ' + el.tutor_comment;
      div.appendChild(hr);
      div.appendChild(comment);
    }

    /* Click handlers */
    div.addEventListener('click', (e) => {
      if (e.target.closest('a, input')) return;
      if (state.isTutor && state.linkMode) {
        handleLinkClick(el.id, div);
        return;
      }
      openElementModal(el, !state.isTutor);
    });

    /* Drag for tutor */
    if (state.isTutor) {
      div.setAttribute('draggable', 'true');
      div.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(el.id));
      });
    }

    return div;
  }

  /* ══════════════════════════════════════════════
     CONNECTIONS (SVG)
  ══════════════════════════════════════════════ */
  function renderConnections() {
    const svg = dom.boardConnections;
    svg.innerHTML = '';

    const connections = state.board?.connections;
    if (!connections?.length) return;

    const byId = Object.fromEntries((state.board.elements || []).map(e => [e.id, e]));

    const W = 3000, H = 3000;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible';

    /* Arrow marker */
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arr', markerWidth: 10, markerHeight: 7, refX: 9, refY: 3.5, orient: 'auto' });
    const poly   = svgEl('polygon', { points: '0 0,10 3.5,0 7', fill: '#7b6ef6' });
    marker.appendChild(poly);
    defs.appendChild(marker);
    svg.appendChild(defs);

    connections.forEach((c, i) => {
      const from = byId[c.from_element_id];
      const to   = byId[c.to_element_id];
      if (!from || !to) return;

      const x1 = from.x + from.width / 2;
      const y1 = from.y + (from.height || 100);
      const x2 = to.x + to.width / 2;
      const y2 = to.y;
      const midY = y1 + (y2 - y1) / 2;

      const path = svgEl('path', {
        d: `M${x1},${y1} L${x1},${midY} L${x2},${midY} L${x2},${y2}`,
        fill: 'none',
        stroke: '#7b6ef6',
        'stroke-width': 2,
        'stroke-dasharray': '0',
        'marker-end': 'url(#arr)',
        opacity: 0,
        style: `animation: fadeIn .3s ease ${i * 0.04}s both`,
      });
      svg.appendChild(path);
      // simple fade-in via requestAnimationFrame
      requestAnimationFrame(() => { path.style.opacity = '1'; });
    });
  }

  /* ══════════════════════════════════════════════
     FULL BOARD RENDER
  ══════════════════════════════════════════════ */
  function renderBoard() {
    dom.boardElements.innerHTML = '';
    (state.board?.elements || []).forEach(el => {
      dom.boardElements.appendChild(buildElementNode(el));
    });
    renderConnections();
    updateMinimap();
  }

  /* ══════════════════════════════════════════════
     MINIMAP
  ══════════════════════════════════════════════ */
  function updateMinimap() {
    const canvas = dom.minimapCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth  || 180;
    const H = canvas.offsetHeight || 120;
    canvas.width  = W;
    canvas.height = H;

    const stageW = 3000, stageH = 3000;
    const scaleX = W / stageW;
    const scaleY = H / stageH;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f0f1c';
    ctx.fillRect(0, 0, W, H);

    // draw connections
    const connections = state.board?.connections || [];
    const byId = Object.fromEntries((state.board?.elements || []).map(e => [e.id, e]));
    ctx.strokeStyle = 'rgba(123,110,246,.5)';
    ctx.lineWidth = 1;
    connections.forEach(c => {
      const f = byId[c.from_element_id], t = byId[c.to_element_id];
      if (!f || !t) return;
      ctx.beginPath();
      ctx.moveTo((f.x + f.width / 2) * scaleX, (f.y + (f.height || 80)) * scaleY);
      ctx.lineTo((t.x + t.width / 2) * scaleX, t.y * scaleY);
      ctx.stroke();
    });

    // draw elements
    (state.board?.elements || []).forEach(el => {
      ctx.fillStyle = el.background_color || '#fff';
      ctx.strokeStyle = el.border_color || '#333';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.rect(el.x * scaleX, el.y * scaleY, el.width * scaleX, (el.height || 80) * scaleY);
      ctx.fill();
      ctx.stroke();
    });

    // viewport indicator
    const container = dom.boardContainer;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vx = (-state.panX / (state.zoom / 100)) * scaleX;
    const vy = (-state.panY / (state.zoom / 100)) * scaleY;
    const vw = (cw / (state.zoom / 100)) * scaleX;
    const vh = (ch / (state.zoom / 100)) * scaleY;

    const vp = dom.minimapViewport;
    if (vp) {
      vp.style.left   = Math.max(0, vx) + 'px';
      vp.style.top    = Math.max(0, vy) + 'px';
      vp.style.width  = Math.min(W, vw) + 'px';
      vp.style.height = Math.min(H, vh) + 'px';
    }
  }

  /* ══════════════════════════════════════════════
     ZOOM / PAN
  ══════════════════════════════════════════════ */
  function applyTransform() {
    dom.boardStage.style.transform =
      `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom / 100})`;
    dom.zoomPercent.textContent = Math.round(state.zoom) + '%';
    updateMinimap();
  }

  dom.zoomSlider.addEventListener('input', () => {
    state.zoom = parseInt(dom.zoomSlider.value, 10);
    applyTransform();
  });

  // Wheel zoom
  dom.boardContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -5 : 5;
    state.zoom = Math.min(200, Math.max(20, state.zoom + delta));
    dom.zoomSlider.value = state.zoom;
    applyTransform();
  }, { passive: false });

  // Pan
  dom.boardContainer.addEventListener('mousedown', (e) => {
    if (e.target.closest('.board-element, .board-minimap')) return;
    state.drag = { startX: e.clientX, startY: e.clientY, startPanX: state.panX, startPanY: state.panY };
  });
  document.addEventListener('mousemove', (e) => {
    if (!state.drag) return;
    state.panX = state.drag.startPanX + (e.clientX - state.drag.startX);
    state.panY = state.drag.startPanY + (e.clientY - state.drag.startY);
    applyTransform();
  });
  document.addEventListener('mouseup', () => { state.drag = null; });

  /* ══════════════════════════════════════════════
     FILTERS
  ══════════════════════════════════════════════ */
  [dom.filterUnviewed, dom.filterDateFrom, dom.filterDateTo].forEach(el => {
    el.addEventListener('change', renderBoard);
  });
  dom.btnResetFilters.addEventListener('click', () => {
    dom.filterUnviewed.checked = false;
    dom.filterDateFrom.value   = '';
    dom.filterDateTo.value     = '';
    renderBoard();
  });

  /* ══════════════════════════════════════════════
     LINK MODE
  ══════════════════════════════════════════════ */
  dom.btnLinkMode.addEventListener('click', () => {
    state.linkMode = !state.linkMode;
    state.linkSourceId = null;
    document.querySelectorAll('.board-element.link-source').forEach(el => el.classList.remove('link-source'));
    dom.btnLinkMode.classList.toggle('btn-primary', state.linkMode);
    dom.btnLinkMode.classList.toggle('btn-outline-secondary', !state.linkMode);
    dom.btnLinkMode.textContent = state.linkMode ? '✕ Отмена' : 'Связать';
  });

  function handleLinkClick(id, divEl) {
    if (!state.linkSourceId) {
      state.linkSourceId = id;
      divEl.classList.add('link-source');
      return;
    }
    if (state.linkSourceId === id) {
      state.linkSourceId = null;
      divEl.classList.remove('link-source');
      return;
    }
    // Create connection
    API.createConnection(state.courseId, state.linkSourceId, id)
      .then(conn => {
        state.board.connections = state.board.connections || [];
        state.board.connections.push(conn);
        renderConnections();
        updateMinimap();
      })
      .catch(err => toast(err.message || 'Ошибка связи', 'error'));

    // reset link mode
    state.linkSourceId = null;
    state.linkMode = false;
    document.querySelectorAll('.board-element.link-source').forEach(el => el.classList.remove('link-source'));
    dom.btnLinkMode.classList.remove('btn-primary');
    dom.btnLinkMode.classList.add('btn-outline-secondary');
    dom.btnLinkMode.textContent = 'Связать';
  }

  /* ══════════════════════════════════════════════
     DELETE ALL CONNECTIONS
  ══════════════════════════════════════════════ */
  dom.btnDeleteConns.addEventListener('click', async () => {
    if (!confirm('Удалить все связи?')) return;
    try {
      await API.deleteAllConnections(state.courseId);
      state.board.connections = [];
      renderConnections();
      updateMinimap();
      toast('Связи удалены');
    } catch (err) {
      toast(err.message || 'Ошибка', 'error');
    }
  });

  /* ══════════════════════════════════════════════
     ADD ELEMENT
  ══════════════════════════════════════════════ */
  dom.btnAddElement.addEventListener('click', () => {
    ['newElTitle','newElContentUrl','newElFileUrl','newElComment'].forEach(id => { $(id).value = ''; });
    $('newElX').value = 100 + Math.floor(Math.random() * 300);
    $('newElY').value = 100 + Math.floor(Math.random() * 200);
    $('newElBg').value = '#ffffff';
    $('newElBorder').value = '#333333';
    new bootstrap.Modal('#modalNewElement').show();
  });

  $('btnCreateElement').addEventListener('click', async () => {
    const title = $('newElTitle').value.trim();
    if (!title) { $('newElTitle').focus(); return; }
    try {
      const el = await API.createElement(state.courseId, {
        title,
        content_url:      $('newElContentUrl').value.trim(),
        file_url:         $('newElFileUrl').value.trim(),
        tutor_comment:    $('newElComment').value.trim(),
        x:                parseFloat($('newElX').value) || 100,
        y:                parseFloat($('newElY').value) || 100,
        background_color: $('newElBg').value,
        border_color:     $('newElBorder').value,
      });
      state.board.elements.push({ ...el, viewed: false });
      bootstrap.Modal.getInstance('#modalNewElement').hide();
      renderBoard();
      toast('Элемент добавлен', 'success');
    } catch (err) {
      toast(err.data?.detail || err.message || 'Ошибка', 'error');
    }
  });

  /* ══════════════════════════════════════════════
     ELEMENT MODAL
  ══════════════════════════════════════════════ */
  function openElementModal(el, viewOnly) {
    const body = $('modalElementBody');
    $('modalElementTitle').textContent = el.title;

    if (viewOnly) {
      body.innerHTML = `
        <div class="mb-2"><strong style="color:var(--text-mid);font-size:12px">НАЗВАНИЕ</strong>
          <p class="mb-0 mt-1">${escHtml(el.title)}</p></div>
        <div class="row mb-2">
          <div class="col-6"><strong style="color:var(--text-mid);font-size:12px">ДОБАВЛЕНО</strong>
            <p class="mb-0 mt-1" style="font-family:var(--font-mono);font-size:13px">${fmtDate(el.created_at)}</p></div>
          <div class="col-6"><strong style="color:var(--text-mid);font-size:12px">ОБНОВЛЕНО</strong>
            <p class="mb-0 mt-1" style="font-family:var(--font-mono);font-size:13px">${fmtDate(el.updated_at)}</p></div>
        </div>
        ${el.content_url ? `<div class="mb-2"><a href="${escHtml(el.content_url)}" target="_blank" class="btn btn-outline-secondary btn-sm">↗ Открыть контент</a></div>` : ''}
        ${el.file_url    ? `<div class="mb-2"><a href="${escHtml(el.file_url)}"    target="_blank" class="btn btn-outline-secondary btn-sm">↓ Открыть файл</a></div>` : ''}
        ${el.tutor_comment ? `<div class="mt-2 p-3" style="background:var(--bg-elevated);border-radius:8px;font-size:13px;color:var(--text-mid)">✎ ${escHtml(el.tutor_comment)}</div>` : ''}
      `;
      $('btnSaveElement').classList.add('d-none');
      $('btnDeleteElement').classList.add('d-none');
    } else {
      body.innerHTML = `
        <div class="mb-2"><label class="form-label">Название</label>
          <input type="text" class="form-control" id="editElTitle" value="${escHtml(el.title)}"></div>
        <div class="mb-2"><label class="form-label">Ссылка на контент</label>
          <input type="url" class="form-control" id="editElContentUrl" value="${escHtml(el.content_url||'')}"></div>
        <div class="mb-2"><label class="form-label">Ссылка на файл</label>
          <input type="url" class="form-control" id="editElFileUrl" value="${escHtml(el.file_url||'')}"></div>
        <div class="mb-2"><label class="form-label">Комментарий тьютора</label>
          <input type="text" class="form-control" id="editElComment" value="${escHtml(el.tutor_comment||'')}"></div>
        <div class="row mb-2">
          <div class="col-3"><label class="form-label">X</label><input type="number" class="form-control" id="editElX" value="${el.x}"></div>
          <div class="col-3"><label class="form-label">Y</label><input type="number" class="form-control" id="editElY" value="${el.y}"></div>
          <div class="col-3"><label class="form-label">Ширина</label><input type="number" class="form-control" id="editElW" value="${el.width}"></div>
          <div class="col-3"><label class="form-label">Высота</label><input type="number" class="form-control" id="editElH" value="${el.height}"></div>
        </div>
        <div class="row mb-2">
          <div class="col-6"><label class="form-label">Фон</label>
            <input type="color" class="form-control form-control-color" id="editElBg" value="${el.background_color||'#ffffff'}"></div>
          <div class="col-6"><label class="form-label">Граница</label>
            <input type="color" class="form-control form-control-color" id="editElBorder" value="${el.border_color||'#333333'}"></div>
        </div>
      `;
      $('btnSaveElement').classList.remove('d-none');
      $('btnDeleteElement').classList.remove('d-none');

      $('btnSaveElement').onclick = () => saveElement(el);
      $('btnDeleteElement').onclick = () => deleteElement(el);
    }

    new bootstrap.Modal('#modalElement').show();
  }

  async function saveElement(el) {
    const data = {
      title:            $('editElTitle').value.trim() || el.title,
      content_url:      $('editElContentUrl').value.trim(),
      file_url:         $('editElFileUrl').value.trim(),
      tutor_comment:    $('editElComment').value.trim(),
      x:                parseFloat($('editElX').value) || el.x,
      y:                parseFloat($('editElY').value) || el.y,
      width:            parseFloat($('editElW').value) || el.width,
      height:           parseFloat($('editElH').value) || el.height,
      background_color: $('editElBg').value,
      border_color:     $('editElBorder').value,
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
    if (!confirm('Удалить элемент «' + el.title + '»?')) return;
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

  /* ══════════════════════════════════════════════
     WEBSOCKET
  ══════════════════════════════════════════════ */
  let ws = null;
  let wsReconnectTimer = null;
  let wsIntentionallyClosed = false;

  function wsSetStatus(s) {
    dom.wsStatus.className = 'ws-status ' + s;
    dom.wsStatus.title = { connected: 'WS: подключён', reconnecting: 'WS: переподключение…', '': 'WS: отключён' }[s] || '';
  }

  function connectWS() {
    if (!state.courseId) return;
    wsIntentionallyClosed = false;
    wsSetStatus('reconnecting');

    const url = getWsUrl() + '/ws/course/' + state.courseId;
    try { ws = new WebSocket(url); }
    catch (_) { scheduleReconnect(); return; }

    ws.onopen = () => {
      wsSetStatus('connected');
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    };

    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      handleWsMessage(msg);
    };

    ws.onerror = () => {};
    ws.onclose = ({ code }) => {
      ws = null;
      wsSetStatus('');
      if (!wsIntentionallyClosed && code !== 1000) scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsSetStatus('reconnecting');
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (!wsIntentionallyClosed && state.courseId) connectWS();
    }, 3000);
  }

  function disconnectWS() {
    wsIntentionallyClosed = true;
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
    if (ws) { ws.close(1000); ws = null; }
  }

  function handleWsMessage(msg) {
    const { type, payload } = msg;
    const elements    = state.board.elements    = state.board.elements    || [];
    const connections = state.board.connections = state.board.connections || [];

    switch (type) {
      case 'element_added':
        elements.push({ ...payload, viewed: false });
        renderBoard();
        break;
      case 'element_updated': {
        const idx = elements.findIndex(e => e.id === payload.id);
        if (idx >= 0) elements[idx] = { ...payload, viewed: elements[idx].viewed };
        renderBoard();
        break;
      }
      case 'element_removed':
        state.board.elements = elements.filter(e => e.id !== payload.element_id);
        renderBoard();
        break;
      case 'connection_added':
        connections.push(payload);
        renderConnections();
        updateMinimap();
        break;
      case 'connection_removed':
        state.board.connections = connections.filter(c => c.id !== payload.connection_id);
        renderConnections();
        updateMinimap();
        break;
      case 'connections_cleared':
        state.board.connections = [];
        renderConnections();
        updateMinimap();
        break;
      case 'course_updated':
        state.board.course = payload;
        dom.courseTitle.textContent = payload.title;
        break;
    }
  }

  /* ══════════════════════════════════════════════
     PUBLISH TOGGLE
  ══════════════════════════════════════════════ */
  function updatePublishBtn() {
    const isPublic = state.board.course.is_public;
    dom.btnPublish.textContent = isPublic ? 'Сделать приватным' : 'Опубликовать';
    dom.btnPublish.className = `btn btn-sm ${isPublic ? 'btn-danger' : 'btn-success'}`;
  }

  dom.btnPublish.addEventListener('click', async () => {
    try {
      const updated = await API.updateCourse(state.courseId, { is_public: !state.board.course.is_public });
      state.board.course = updated;
      updatePublishBtn();
      toast(updated.is_public ? 'Курс опубликован' : 'Курс скрыт', 'success');
    } catch (err) {
      toast(err.message || 'Ошибка', 'error');
    }
  });

  /* ══════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════ */
  async function init() {
    if (!isAuthenticated()) { location.href = 'login.html'; return; }

    state.courseId = getCourseId();
    if (!state.courseId) { location.href = 'courses.html'; return; }

    try {
      const [board, me] = await Promise.all([
        API.getCourseBoard(state.courseId),
        API.me().catch(() => null),
      ]);
      state.board = board;
      state.me    = me;
      state.isTutor = !!(me && board.course && board.course.tutor_id === me.id);

      dom.courseTitle.textContent = board.course.title;
      document.title = board.course.title + ' — Nexus Learn';

      if (state.isTutor) {
        [dom.btnPublish, dom.btnAddElement, dom.btnLinkMode, dom.btnDeleteConns].forEach(el => {
          el.classList.remove('d-none');
        });
        updatePublishBtn();
      }

      applyTransform();
      renderBoard();
      connectWS();
      window.addEventListener('beforeunload', disconnectWS);

    } catch (err) {
      if (err.status === 403 || err.status === 401 && !isAuthenticated()) {
        location.href = '403.html';
      } else if (err.status === 401) {
        clearToken();
        location.href = 'login.html';
      } else if (err.status === 404) {
        toast('Курс не найден', 'error');
        setTimeout(() => { location.href = 'courses.html'; }, 2000);
      } else {
        location.href = 'courses.html';
      }
    }
  }

  init();
})();
