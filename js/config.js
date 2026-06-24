// API base URL: backend runs on port 8000
// const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
//   ? 'http://127.0.0.1:8000'
//   : (window.location.protocol + '//' + window.location.hostname + ':8000');

// const API_BASE_URL = "http://vfxbuja-m5.prof.ru:8111"

// const API_BASE_URL = "http://192.168.0.11:8111"
const API_BASE_URL = "https://diplom-backend-production-fe9d.up.railway.app"

/**
 * Базовый URL для WebSocket (доска курса).
 * Пример: ws://127.0.0.1:8000 — соединение к каналу /ws/course/{course_id}.
 * Формат сообщений и типы событий см. в docs/WEBSOCKET.md.
 */
function getWsUrl() {
  return API_BASE_URL.replace(/^http/, 'ws');
}
