// ═══════════════════════════════════════════════════════════
// BoxDental Firebase Sync Layer v3 — Sincronización bidireccional
// Si local es más reciente → sube a Firebase
// Si Firebase es más reciente → baja a local
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
  var initialUploadDone = {};  // track which keys were uploaded on auth

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

      // Offline persistence
      db.enablePersistence({ synchronizeTabs: true }).catch(function(err) {
        if (err.code === 'failed-precondition') {
          console.warn('[BXD_FB] Persistencia solo en una pestaña');
        }
      });

      auth.onAuthStateChanged(function(user) {
        currentUser = user;
        if (user) {
          console.log('[BXD_FB] Autenticado:', user.email || 'anónimo');
          showSyncStatus('conectado');

          // Procesar saves pendientes
          var pending = pendingSaves.slice();
          pendingSaves = [];
          pending.forEach(function(p) { pushToFirestore(p.key, p.data); });

          // Subir datos locales existentes a Firebase (sincronización inicial)
          uploadLocalDataOnAuth();

          // Activar listeners en tiempo real
          Object.keys(syncCallbacks).forEach(function(key) {
            startRealtimeListener(key);
          });
        } else {
          showSyncStatus('sin-sesion');
          Object.keys(realtimeUnsubs).forEach(function(key) {
            if (realtimeUnsubs[key]) { realtimeUnsubs[key](); delete realtimeUnsubs[key]; }
          });
          tryAutoLogin();
        }
      });

      ready = true;
      tryAutoLogin();
      console.log('[BXD_FB] Firebase listo v3');
    } catch(e) {
      console.error('[BXD_FB] Error de inicialización:', e);
      showSyncStatus('error');
    }
  }

  // ── Subir datos locales a Firebase al autenticarse ─────────
  function uploadLocalDataOnAuth() {
    Object.keys(KEY_TO_DOC).forEach(function(lsKey) {
      if (initialUploadDone[lsKey]) return;
      var localRaw = localStorage.getItem(lsKey);
      if (!localRaw) return;
      try {
        var localData = JSON.parse(localRaw);
        var localTime = localData.savedAt ? new Date(localData.savedAt).getTime() : 0;
        if (!localTime) return; // Sin timestamp, no subir

        // Verificar si Firebase tiene datos más recientes antes de subir
        var docName = KEY_TO_DOC[lsKey];
        if (!docName || !db) return;

        db.collection(COLLECTION).doc(docName).get().then(function(doc) {
          var fbTime = doc.exists ? (doc.data()._savedAt || 0) : 0;
          if (!doc.exists || localTime > fbTime) {
            console.log('[BXD_FB] Subiendo datos locales al iniciar sesión:', docName);
            pushToFirestore(lsKey, localData);
          }
          initialUploadDone[lsKey] = true;
        }).catch(function(err) {
          console.warn('[BXD_FB] Error verificando doc para upload inicial:', err.message);
        });
      } catch(e) {
        console.warn('[BXD_FB] Error parseando localStorage para upload:', lsKey);
      }
    });
  }

  // ── Auto-login desde sesión guardada ─────────────────────
  function tryAutoLogin() {
    if (!auth || currentUser) return;
    if (authRetryCount > 3) {
      signInAnonymously();
      return;
    }
    authRetryCount++;
    var session = sessionStorage.getItem('bxd_session_v1') || localStorage.getItem('bxd_session_v1');
    if (!session) { signInAnonymously(); return; }
    try {
      var s = JSON.parse(session);
      var email = USER_EMAILS[s.user];
      var pass  = s.fbPass;
      if (email && pass) {
        auth.signInWithEmailAndPassword(email, pass)
          .catch(function(err) {
            if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
              return auth.createUserWithEmailAndPassword(email, pass)
                .then(function(c) { return c.user.updateProfile({ displayName: s.user }); })
                .catch(function() { signInAnonymously(); });
            } else {
              signInAnonymously();
            }
          });
      } else {
        signInAnonymously();
      }
    } catch(e) { signInAnonymously(); }
  }

  function signInAnonymously() {
    if (!auth || currentUser) return;
    auth.signInAnonymously().catch(function(e) {
      console.warn('[BXD_FB] Anon auth failed:', e.message);
      showSyncStatus('sin-conexion');
    });
  }

  // ── Listener en tiempo real (onSnapshot) — BIDIRECCIONAL ─
  function startRealtimeListener(lsKey) {
    var docName = KEY_TO_DOC[lsKey];
    if (!docName || !db || !currentUser) return;

    if (realtimeUnsubs[lsKey]) {
      realtimeUnsubs[lsKey]();
    }

    console.log('[BXD_FB] Listener tiempo real:', docName);

    var unsub = db.collection(COLLECTION).doc(docName)
      .onSnapshot(function(doc) {

        // ── Documento NO existe en Firebase ──────────────────
        if (!doc.exists) {
          var localRaw = localStorage.getItem(lsKey);
          if (localRaw) {
            try {
              var localData = JSON.parse(localRaw);
              pushToFirestore(lsKey, localData);
              console.log('[BXD_FB] Documento nuevo — subiendo local:', docName);
            } catch(e) {}
          }
          return;
        }

        // ── Documento EXISTE en Firebase ─────────────────────
        var fbData = doc.data();
        var fbTime = fbData._savedAt || 0;

        var localRaw = localStorage.getItem(lsKey);
        var localTime = 0;
        if (localRaw) {
          try {
            var parsed = JSON.parse(localRaw);
            localTime = parsed.savedAt ? new Date(parsed.savedAt).getTime() : 0;
          } catch(e) {}
        }

        if (localRaw && localTime > fbTime + 2000) {
          // Local es MÁS RECIENTE que Firebase (margen de 2s) → subir local
          console.log('[BXD_FB] Local más reciente → subiendo a nube:', docName, 'local:', localTime, 'fb:', fbTime);
          try {
            pushToFirestore(lsKey, JSON.parse(localRaw));
          } catch(e) {}

        } else if (fbTime > localTime || !localRaw) {
          // Firebase es MÁS RECIENTE → actualizar local y notificar módulo
          var cleanData = {};
          Object.keys(fbData).forEach(function(k) {
            if (k.charAt(0) !== '_') cleanData[k] = fbData[k];
          });

          var dataStr = JSON.stringify(cleanData);
          localStorage.setItem(lsKey, dataStr);
          try { sessionStorage.setItem(lsKey, dataStr); } catch(e) {}
          showSyncStatus('sincronizado');
          console.log('[BXD_FB] Firebase más reciente → actualizando local:', docName);

          if (syncCallbacks[lsKey]) {
            syncCallbacks[lsKey](cleanData);
          }
        }
        // Si son iguales (misma data) → no hacer nada

      }, function(err) {
        console.warn('[BXD_FB] Error listener:', docName, err.message);
        showSyncStatus('error');
        setTimeout(function() { startRealtimeListener(lsKey); }, 5000);
      });

    realtimeUnsubs[lsKey] = unsub;
  }

  // ── Push a Firestore ──────────────────────────────────────
  function pushToFirestore(lsKey, data) {
    var docName = KEY_TO_DOC[lsKey];
    if (!docName) return;

    if (!db || !currentUser) {
      pendingSaves.push({ key: lsKey, data: data });
      showSyncStatus('pendiente');
      return;
    }

    var fbData = {};
    Object.keys(data).forEach(function(k) { fbData[k] = data[k]; });
    fbData._savedAt = Date.now();
    fbData._savedBy = currentUser.email || currentUser.uid || 'unknown';

    showSyncStatus('guardando');

    db.collection(COLLECTION).doc(docName).set(fbData)
      .then(function() {
        console.log('[BXD_FB] Guardado en nube:', docName);
        showSyncStatus('sincronizado');
      })
      .catch(function(err) {
        console.warn('[BXD_FB] Error al guardar:', docName, err.message);
        showSyncStatus('error');
        setTimeout(function() { pushToFirestore(lsKey, data); }, 3000);
      });
  }

  // ── Indicador de estado de sincronización ─────────────────
  function showSyncStatus(estado) {
    var el = document.getElementById('fbSyncStatus');
    if (!el) return;
    var estados = {
      'sincronizado': { text: '☁️ Sincronizado',             color: '#059669' },
      'guardando':    { text: '⏳ Guardando en la nube...',  color: '#d97706' },
      'pendiente':    { text: '📶 Sin conexión — guardado local', color: '#f59e0b' },
      'conectado':    { text: '🔗 Conectado',                 color: '#059669' },
      'sin-sesion':   { text: '🔒 Sincronización en espera', color: '#64748b' },
      'sin-conexion': { text: '❌ Sin conexión a Firebase',  color: '#dc2626' },
      'error':        { text: '⚠️ Error de sincronización',  color: '#dc2626' }
    };
    var cfg = estados[estado] || {};
    el.textContent = cfg.text || '';
    el.style.color  = cfg.color || '#64748b';
  }

  // ── API Pública ───────────────────────────────────────────
  window.BXD_FB = {
    save: function(lsKey, data) {
      pushToFirestore(lsKey, data);
    },

    load: function(lsKey, callback) {
      syncCallbacks[lsKey] = callback;
      if (ready && currentUser) {
        startRealtimeListener(lsKey);
      }
    },

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

    forceSync: function(lsKey) {
      if (lsKey) {
        startRealtimeListener(lsKey);
      } else {
        Object.keys(syncCallbacks).forEach(function(k) { startRealtimeListener(k); });
      }
    },

    // Forzar subida de datos locales a Firebase
    forceUpload: function(lsKey) {
      var keys = lsKey ? [lsKey] : Object.keys(KEY_TO_DOC);
      keys.forEach(function(k) {
        var localRaw = localStorage.getItem(k);
        if (localRaw) {
          try { pushToFirestore(k, JSON.parse(localRaw)); } catch(e) {}
        }
      });
    },

    signOut:    function() { if (auth) return auth.signOut(); return Promise.resolve(); },
    isReady:    function() { return ready; },
    isSignedIn: function() { return !!currentUser; },
    getUser:    function() { return currentUser; },
    getUserEmails: function() { return USER_EMAILS; }
  };

  loadNext();
})();
