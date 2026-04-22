// ═══ BoxDental Auth Guard ═══
// Include this script in any page to protect it with login
// If no valid session exists, redirects to index.html (login page)
// Also checks role-based permissions for restricted pages

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

    // Pages restricted to admin only
    const ADMIN_PAGES = [
      'Planificador_BoxDental.html'
    ];

    // Check if current page is admin-only
    const currentPage = window.location.pathname.split('/').pop();
    const isAdminPage = ADMIN_PAGES.some(p => currentPage.includes(p));

    if (isAdminPage && s.role !== 'admin') {
      // Not authorized - redirect to index with error
      sessionStorage.setItem('bxd_access_denied', '1');
      window.location.href = 'index.html';
      return;
    }

    // Session valid - expose user info
    window.BXD_USER = { user: s.user, name: s.name, role: s.role };
  } catch(e) {
    window.location.href = 'index.html';
  }
})();
