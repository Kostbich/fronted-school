const TOKEN_KEY = 'token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function isAuthenticated() {
  return !!getToken();
}

function getAuthHeader() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
