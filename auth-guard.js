// ═══ BoxDental Auth Guard v2 ═══
// Protege páginas por sesión y rol
// admin    → acceso total
// subadmin → todo menos Planificador
// vendedor → Facturacion, Caja, Inventario (lectura), Chat

(function() {
  const SESSION_KEY = 'bxd_session_v1';
  const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);

  if (!raw) {
    window.location.href = 'index.html';
    return;
  }

  try {
    const s = JSON.parse(raw);

    // Sesión válida por 30 días
    if (Date.now() - s.ts > 30 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      window.location.href = 'index.html';
      return;
    }

    // Permisos por página: lista de roles permitidos
    const PAGE_ROLES = {
      'Planificador_BoxDental.html':    ['admin'],
      'Reportes_BoxDental.html':        ['admin', 'subadmin'],
      'CuentasPorPagar_BoxDental.html': ['admin', 'subadmin'],
    };

    const currentPage = (window.location.pathname.split('/').pop() || 'index.html');
    const requiredRoles = PAGE_ROLES[currentPage];

    if (requiredRoles && !requiredRoles.includes(s.role)) {
      sessionStorage.setItem('bxd_access_denied', '1');
      window.location.href = 'index.html';
      return;
    }

    // Exponer info de sesión a la página
    window.BXD_USER = { user: s.user, name: s.name, role: s.role };

  } catch(e) {
    window.location.href = 'index.html';
  }
})();
