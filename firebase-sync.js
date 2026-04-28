// ═══════════════════════════════════════════════════════════
// BoxDental Firebase Sync Layer v2 — Firebase como fuente principal
// Sincronización en tiempo real, offline persistence, auto-recovery
// ═══════════════════════════════════════════════════════════

(function() {
  var config = {
    apiKey: "AIzaSyDVa1FeTstjUq92oSsyjco6udhMUL1W4DY",
    authDomain: "boxdentalec-6fca7.firebaseapp.com",
    projectId: "boxdentalec-6fca7",
    storageBucket: "boxdentalec-6fca7.firebasestorage.app",
    messagingSenderId: "18161204785",
    appId: "1:18161204785:web:b72fa4b80bf8f6955b1f10"
  };

  var USER_EMAILS = {
    'admin':    'admin@boxdental.ec',
    'fernando': 'fernando@boxdental.ec',
    'ventas':   'ventas@boxdental.ec'
  };

  var KEY_TO_DOC = {
    'bxd_inv_v2':      'inventory',
    'bxd_fact_v1':     'billing',
    'bd_tasks_v3':     'planner_tasks',
    'bd_progress_v1':  'planner_progress',
    'bxd_cxp_v1':      'accounts_payable',
    'bxd_chat_v1':     'chat_messages'
  };

  var COLLECTION = 'app_data';
  var cdnBase = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var scripts = [
    cdnBase + 'firebase-app-compat.js',
    cdnBase + 'firebase-auth-compat.js',
    cdnBase + 'firebase-firestore-compat.js'
  ];

  var db = null;
  var auth = null;
  var currentUser = null;
  var syncCallbacks = {};   // key → callback(data)
  var realtimeUnsubs = {};  // key → unsubscribe fn
  var pendingSaves = [];
  var ready = false;
  var authRetryCount = 0;

  // ── Load Firebase SDK ──────────────────────────────────────
  var loadIdx = 0;
  function loadNext() {
    if (loadIdx >= scripts.length) { initFirebase(); return; }
    var s = document.createElement('script');
    s.src = scripts[loadIdx];
    s.onload = function() { loadIdx++; loadNext(); };
    s.onerror = function() {
      console.warn('[BXD_FB] CDN failed for:', scripts[loadIdx]);
      loadIdx++; loadNext();
    };
    document.head.appendChild(s);
  }

  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') {
        console.warn('[BXD_FB] Firebase SDK no disponible');
        showSyncStatus('sin-conexion');
        return;
      }

      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }

      db   = firebase.firestore();
      auth = firebase.auth();

      // Offline persistence — datos disponibles sin internet
      db.enablePersistence({ synchronizeTabs: true }).catch(function(err) {
        if (err.code === 'failed-precondition') {
          // Múltiples pestañas — solo una puede tener persistencia
          console.warn('[BXD_FB] Persistencia solo en una pestaña');
        }
      });

      // Escuchar cambios de autenticación
      auth.onAuthStateChanged(function(user) {
        currentUser = user;
        if (user) {
          console.log('[BXD_FB] Autenticado:', user.email);
          showSyncStatus('conectado');
          // Procesar saves pendientes
          var pending = pendingSaves.slice();
          pendingSaves = [];
          pending.forEach(function(p) { pushToFirestore(p.key, p.data); });
          // Activar listeners en tiempo real para todas las keys registradas
          Object.keys(syncCallbacks).forEach(function(key) {
            startRealtimeListener(key);
          });
        } else {
          showSyncStatus('sin-sesion');
          // Detener todos los listeners
          Object.keys(realtimeUnsubs).forEach(function(key) {
            if (realtimeUnsubs[key]) { realtimeUnsubs[key](); delete realtimeUnsubs[key]; }
          });
          // Auto-reintentar login desde sesión guardada
          tryAutoLogin();
        }
      });

      ready = true;
      tryAutoLogin();
      console.log('[BXD_FB] Firebase listo v2');
    } catch(e) {
      console.error('[BXD_FB] Error de inicialización:', e);
      showSyncStatus('error');
    }
  }

  // ── Auto-login desde sesión guardada ─────────────────────
  function tryAutoLogin() {
    if (authRetryCount > 3) return;
    authRetryCount++;
    var session = sessionStorage.getItem('bxd_session_v1') || localStorage.getItem('bxd_session_v1');
    if (!session || !auth) return;
    try {
      var s = JSON.parse(session);
      var email = USER_EMAILS[s.user];
      var pass  = s.fbPass;
      if (email && pass && !currentUser) {
        auth.signInWithEmailAndPassword(email, pass)
          .catch(function(err) {
            // Si el usuario no existe en Firebase Auth, crearlo
            if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
              return auth.createUserWithEmailAndPassword(email, pass)
                .then(function(c) { return c.user.updateProfile({ displayName: s.user }); })
                .catch(function() {});
            }
          });
      }
    } catch(e) {}
  }

  // ── Listener en tiempo real (onSnapshot) ─────────────────
  function startRealtimeListener(lsKey) {
    var docName = KEY_TO_DOC[lsKey];
    if (!docName || !db || !currentUser) return;

    // Cancelar listener previo si existe
    if (realtimeUnsubs[lsKey]) {
      realtimeUnsubs[lsKey]();
    }

    console.log('[BXD_FB] Iniciando listener tiempo real:', docName);

    var unsub = db.collection(COLLECTION).doc(docName)
      .onSnapshot(function(doc) {
        if (!doc.exists) {
          // Documento no existe en Firebase — subir localStorage si tiene datos
          var localRaw = localStorage.getItem(lsKey);
          if (localRaw) {
            try {
              var localData = JSON.parse(localRaw);
              pushToFirestore(lsKey, localData);
              console.log('[BXD_FB] Subiendo datos locales a nube:', docName);
            } catch(e) {}
          }
          return;
        }

        var fbData = doc.data();
        // Quitar campos internos con _
        var cleanData = {};
        Object.keys(fbData).forEach(function(k) {
          if (k.charAt(0) !== '_') cleanData[k] = fbData[k];
        });

        // FIREBASE ES LA FUENTE DE VERDAD — siempre actualizar localStorage
        var fbTime = fbData._savedAt || 0;
        var localRaw = localStorage.getItem(lsKey);
        var localTime = 0;
        if (localRaw) {
          try { localTime = JSON.parse(localRaw).savedAt ? new Date(JSON.parse(localRaw).savedAt).getTime() : 0; } catch(e) {}
        }

        // Solo actualizar si Firebase tiene datos más recientes
        // (evitar loop: cuando nosotros guardamos y se dispara el snapshot)
        if (fbTime > localTime || !localRaw) {
          var dataStr = JSON.stringify(cleanData);
          localStorage.setItem(lsKey, dataStr);
          try { sessionStorage.setItem(lsKey, dataStr); } catch(e) {}
          showSyncStatus('sincronizado');
          console.log('[BXD_FB] Datos actualizados desde nube:', docName);
          // Notificar al módulo para que re-renderice
          if (syncCallbacks[lsKey]) {
            syncCallbacks[lsKey](cleanData);
          }
        }
      }, function(err) {
        console.warn('[BXD_FB] Error listener:', docName, err.message);
        showSyncStatus('error');
        // Reintentar en 5 segundos
        setTimeout(function() { startRealtimeListener(lsKey); }, 5000);
      });

    realtimeUnsubs[lsKey] = unsub;
  }

  // ── Push a Firestore ──────────────────────────────────────
  function pushToFirestore(lsKey, data) {
    var docName = KEY_TO_DOC[lsKey];
    if (!docName) return;

    if (!db || !currentUser) {
      // Encolar para cuando se autentique
      pendingSaves.push({ key: lsKey, data: data });
      showSyncStatus('pendiente');
      return;
    }

    var fbData = {};
    Object.keys(data).forEach(function(k) { fbData[k] = data[k]; });
    fbData._savedAt = Date.now();
    fbData._savedBy = currentUser.email || 'unknown';

    showSyncStatus('guardando');

    db.collection(COLLECTION).doc(docName).set(fbData)
      .then(function() {
        console.log('[BXD_FB] Guardado en nube:', docName);
        showSyncStatus('sincronizado');
      })
      .catch(function(err) {
        console.warn('[BXD_FB] Error al guardar:', docName, err.message);
        showSyncStatus('error');
        // Reintentar en 3 segundos
        setTimeout(function() { pushToFirestore(lsKey, data); }, 3000);
      });
  }

  // ── Indicador de estado de sincronización ─────────────────
  function showSyncStatus(estado) {
    var el = document.getElementById('fbSyncStatus');
    if (!el) return;
    var estados = {
      'sincronizado': { text: '☁️ Datos sincronizados',       color: '#059669' },
      'guardando':    { text: '⏳ Guardando en la nube...',    color: '#d97706' },
      'pendiente':    { text: '📶 Sin conexión — guardado local', color: '#f59e0b' },
      'conectado':    { text: '🔗 Conectado a la nube',        color: '#059669' },
      'sin-sesion':   { text: '🔒 Sincronización en espera',   color: '#64748b' },
      'sin-conexion': { text: '❌ Sin conexión a Firebase',    color: '#dc2626' },
      'error':        { text: '⚠️ Error de sincronización',    color: '#dc2626' }
    };
    var cfg = estados[estado] || {};
    el.textContent = cfg.text || '';
    el.style.color  = cfg.color || '#64748b';
  }

  // ── API Pública ───────────────────────────────────────────
  window.BXD_FB = {
    // Guardar datos en Firestore
    save: function(lsKey, data) {
      pushToFirestore(lsKey, data);
    },

    // Registrar clave para sincronización en tiempo real
    // callback(data) se llama cuando Firebase tiene datos nuevos
    load: function(lsKey, callback) {
      syncCallbacks[lsKey] = callback;
      if (ready && currentUser) {
        startRealtimeListener(lsKey);
      }
    },

    // Login explícito desde la página de inicio
    signIn: function(appUsername, appPassword) {
      if (!auth) return Promise.reject(new Error('Firebase no listo'));
      var email = USER_EMAILS[appUsername];
      if (!email) return Promise.reject(new Error('Usuario desconocido'));
      authRetryCount = 0;
      return auth.signInWithEmailAndPassword(email, appPassword)
        .catch(function(err) {
          if (err.code === 'auth/user-not-found' ||
              err.code === 'auth/invalid-credential' ||
              err.code === 'auth/wrong-password') {
            return auth.createUserWithEmailAndPassword(email, appPassword)
              .then(function(cred) {
                return cred.user.updateProfile({ displayName: appUsername }).then(function() { return cred; });
              });
          }
          throw err;
        })
        .then(function(cred) {
          console.log('[BXD_FB] Auth OK:', email);
          return cred;
        });
    },

    // Forzar sincronización desde la nube (útil para botón manual)
    forceSync: function(lsKey) {
      if (lsKey) {
        startRealtimeListener(lsKey);
      } else {
        Object.keys(syncCallbacks).forEach(function(k) { startRealtimeListener(k); });
      }
    },

    signOut:    function() { if (auth) return auth.signOut(); return Promise.resolve(); },
    isReady:    function() { return ready; },
    isSignedIn: function() { return !!currentUser; },
    getUser:    function() { return currentUser; },
    getUserEmails: function() { return USER_EMAILS; }
  };

  loadNext();
})();
