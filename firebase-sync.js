// ═══════════════════════════════════════════════════════════
// BoxDental Firebase Sync Layer
// Loads Firebase SDK, handles auth, syncs data with Firestore
// Include this script in every page BEFORE the main <script>
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

  // User mapping: app username → Firebase Auth email
  var USER_EMAILS = {
    'admin':    'admin@boxdental.ec',
    'fernando': 'fernando@boxdental.ec',
    'ventas':   'ventas@boxdental.ec'
  };

  // localStorage key → Firestore document name
  var KEY_TO_DOC = {
    'bxd_inv_v2':      'inventory',
    'bxd_fact_v1':     'billing',
    'bd_tasks_v3':     'planner_tasks',
    'bd_progress_v1':  'planner_progress',
    'bd_crm_v3':       'reconnection',
    'bxd_rpt_v1':      'reports'
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
  var syncCallbacks = {};
  var ready = false;
  var pendingSaves = [];

  // Load Firebase SDK scripts sequentially
  var loadIdx = 0;
  function loadNext() {
    if (loadIdx >= scripts.length) { initFirebase(); return; }
    var s = document.createElement('script');
    s.src = scripts[loadIdx];
    s.onload = function() { loadIdx++; loadNext(); };
    s.onerror = function() {
      console.warn('[BXD_FB] CDN failed:', scripts[loadIdx]);
      loadIdx++; loadNext();
    };
    document.head.appendChild(s);
  }

  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') {
        console.warn('[BXD_FB] Firebase SDK not loaded');
        return;
      }
      firebase.initializeApp(config);
      db = firebase.firestore();
      auth = firebase.auth();

      // Enable offline persistence for working without internet
      db.enablePersistence({ synchronizeTabs: true }).catch(function(err) {
        if (err.code === 'failed-precondition') {
          console.warn('[BXD_FB] Multiple tabs open, persistence in one tab only');
        } else if (err.code === 'unimplemented') {
          console.warn('[BXD_FB] Browser does not support persistence');
        }
      });

      // Listen for auth state changes
      auth.onAuthStateChanged(function(user) {
        currentUser = user;
        if (user) {
          console.log('[BXD_FB] Signed in:', user.email);
          // Process any pending saves
          pendingSaves.forEach(function(p) { pushToFirestore(p.key, p.data); });
          pendingSaves = [];
          // Pull all registered keys
          Object.keys(syncCallbacks).forEach(function(key) {
            pullFromFirestore(key);
          });
        }
      });

      // Try auto-sign-in from stored session
      var session = sessionStorage.getItem('bxd_session_v1') || localStorage.getItem('bxd_session_v1');
      if (session) {
        try {
          var s = JSON.parse(session);
          var email = USER_EMAILS[s.user];
          if (email && s.fbPass) {
            auth.signInWithEmailAndPassword(email, s.fbPass).catch(function() {});
          }
        } catch(e) {}
      }

      ready = true;
      console.log('[BXD_FB] Firebase ready');
    } catch(e) {
      console.error('[BXD_FB] Init error:', e);
    }
  }

  function pullFromFirestore(lsKey) {
    var docName = KEY_TO_DOC[lsKey];
    if (!docName || !db || !currentUser) return;

    db.collection(COLLECTION).doc(docName).get()
      .then(function(doc) {
        if (!doc.exists) return;
        var fbData = doc.data();
        var fbTime = fbData._savedAt || 0;

        // Check local timestamp
        var lsRaw = localStorage.getItem(lsKey);
        var lsTime = 0;
        if (lsRaw) {
          try {
            var lsData = JSON.parse(lsRaw);
            lsTime = lsData.savedAt ? new Date(lsData.savedAt).getTime() : 0;
          } catch(e) {}
        }

        if (fbTime > lsTime) {
          // Firebase has newer data — update localStorage
          var cleanData = {};
          Object.keys(fbData).forEach(function(k) {
            if (k.charAt(0) !== '_') cleanData[k] = fbData[k];
          });
          localStorage.setItem(lsKey, JSON.stringify(cleanData));
          sessionStorage.setItem(lsKey, JSON.stringify(cleanData));
          console.log('[BXD_FB] Synced from cloud:', docName);
          // Trigger re-render
          if (syncCallbacks[lsKey]) {
            syncCallbacks[lsKey](cleanData);
          }
        }
      })
      .catch(function(err) {
        console.warn('[BXD_FB] Pull error:', docName, err.message);
      });
  }

  function pushToFirestore(lsKey, data) {
    var docName = KEY_TO_DOC[lsKey];
    if (!docName) return;

    if (!db || !currentUser) {
      // Queue for when auth completes
      pendingSaves.push({ key: lsKey, data: data });
      return;
    }

    var fbData = {};
    // Deep copy to avoid mutation
    Object.keys(data).forEach(function(k) {
      fbData[k] = data[k];
    });
    fbData._savedAt = Date.now();
    fbData._savedBy = currentUser.email || 'unknown';

    db.collection(COLLECTION).doc(docName).set(fbData)
      .then(function() {
        console.log('[BXD_FB] Saved to cloud:', docName);
        // Show sync indicator if exists
        var indicator = document.getElementById('fbSyncStatus');
        if (indicator) {
          indicator.textContent = '☁️ Sincronizado';
          indicator.style.color = '#059669';
          setTimeout(function() { indicator.textContent = ''; }, 3000);
        }
      })
      .catch(function(err) {
        console.warn('[BXD_FB] Push error:', docName, err.message);
      });
  }

  // ── Public API ──
  window.BXD_FB = {
    // Save data to Firestore (call after saving to localStorage)
    save: function(lsKey, data) {
      pushToFirestore(lsKey, data);
    },

    // Register a key for sync with a re-render callback
    // callback(data) is called when Firebase has newer data
    load: function(lsKey, callback) {
      syncCallbacks[lsKey] = callback;
      if (ready && currentUser) {
        pullFromFirestore(lsKey);
      }
    },

    // Sign in to Firebase Auth (call from login page)
    signIn: function(appUsername, appPassword) {
      if (!auth) return Promise.reject(new Error('Firebase not ready'));
      var email = USER_EMAILS[appUsername];
      if (!email) return Promise.reject(new Error('Unknown user'));

      return auth.signInWithEmailAndPassword(email, appPassword)
        .catch(function(err) {
          if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
            // Create Firebase Auth user on first login
            return auth.createUserWithEmailAndPassword(email, appPassword)
              .then(function(cred) {
                // Update display name
                return cred.user.updateProfile({ displayName: appUsername }).then(function() {
                  return cred;
                });
              });
          }
          throw err;
        })
        .then(function(cred) {
          console.log('[BXD_FB] Auth OK:', email);
          return cred;
        });
    },

    // Sign out
    signOut: function() {
      if (auth) return auth.signOut();
      return Promise.resolve();
    },

    // Status
    isReady: function() { return ready; },
    isSignedIn: function() { return !!currentUser; },
    getUser: function() { return currentUser; },
    getUserEmails: function() { return USER_EMAILS; }
  };

  // Start loading Firebase SDK
  loadNext();
})();
