const API = {
  async request(path, options = {}) {
    const url = (path.startsWith('http') ? path : API_BASE_URL + path);
    const headers = {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
      ...(options.headers || {})
    };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!res.ok) {
      const err = new Error(data?.detail || res.statusText || 'Ошибка запроса');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  get(path) {
    return this.request(path, { method: 'GET' });
  },

  post(path, body) {
    return this.request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  },

  patch(path, body) {
    return this.request(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
  },

  put(path, body) {
    return this.request(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
  },

  delete(path) {
    return this.request(path, { method: 'DELETE' });
  }
};

// ─── Auth ─────────────────────────────────────────────────
API.register = (email, password, password_confirm) =>
  API.post('/api/auth/register', { email, password, password_confirm });

API.login = (email, password) =>
  API.post('/api/auth/login', { email, password });

API.me = () => API.get('/api/auth/me');

// ─── Courses ──────────────────────────────────────────────
API.getCourses = () => API.get('/api/courses');
API.getCourse = (id) => API.get('/api/courses/' + id);
API.getCourseBoard = (id) => API.get('/api/courses/' + id + '/board');
API.createCourse = (data) => API.post('/api/courses', data);
API.updateCourse = (id, data) => API.patch('/api/courses/' + id, data);
API.deleteCourse = (id) => API.delete('/api/courses/' + id);

// ─── Elements ─────────────────────────────────────────────
API.createElement = (courseId, data) => API.post('/api/courses/' + courseId + '/elements', data);
API.updateElement = (courseId, elementId, data) => API.patch('/api/courses/' + courseId + '/elements/' + elementId, data);
API.deleteElement = (courseId, elementId) => API.delete('/api/courses/' + courseId + '/elements/' + elementId);

// ─── Connections ──────────────────────────────────────────
API.createConnection = (courseId, fromId, toId) =>
  API.post('/api/courses/' + courseId + '/connections', { from_element_id: fromId, to_element_id: toId });
API.deleteConnection = (courseId, connectionId) =>
  API.delete('/api/courses/' + courseId + '/connections/' + connectionId);
API.deleteAllConnections = (courseId) =>
  API.delete('/api/courses/' + courseId + '/connections');

// ─── Progress ─────────────────────────────────────────────
API.setViewed = (courseId, elementId, viewed) =>
  API.put('/api/courses/' + courseId + '/progress', { element_id: elementId, viewed });
