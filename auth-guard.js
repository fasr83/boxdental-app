// ═══ BoxDental Auth Guard ═══
// Include this script in any page to protect it with login
// If no valid session exists, redirects to index.html (login page)

(function() {
  const SESSION_KEY = 'bxd_session_v1';
  const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);

  if (!raw) {
    window.location.href = 'index.html';
    return;
  }

  try {
    const s = JSON.parse(raw);
    // Session expires after 30 days
    if (Date.now() - s.ts > 30 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      window.location.href = 'index.html';
      return;
    }
    // Session valid - expose user info
    window.BXD_USER = { user: s.user, name: s.name };
  } catch(e) {
    window.location.href = 'index.html';
  }
})();
