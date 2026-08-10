// Thin server-side proxy to the İKAS Admin GraphQL API.
//
// Why this exists: İKAS's docs explicitly disallow calling their API directly from a
// browser, and the İKAS client_secret must never ship to the public static frontend.
// This function is the ONLY place that ever sees it.
//
// Design: intentionally "dumb" about İKAS itself — it gets a bearer token (cached in
// memory per warm instance) and forwards {query, variables} to İKAS, returning İKAS's
// raw JSON back unchanged. All İKAS-shape <-> Firestore-shape mapping stays in
// public/index.html, next to the existing processIkasFiles()/runIkasSync() mapping
// logic — see ikasApi() there.
//
// Faz 1 koruması (mutation reddi) hâlâ geçerli — yazma yolu kasıtlı olarak
// tasarlanana kadar salt okunur. Bu kontrolü sadece o iş yapılırken kaldırın/gevşetin.
//
// 2026-08-10: artık uygulamada gerçek bir giriş sistemi (Firebase Auth) olduğu için bu
// uç nokta sayfa kaynağında görünen bir "paylaşılan gizli anahtar" yerine gerçek bir
// Firebase kimlik doğrulama token'ı (Authorization: Bearer <idToken>) istiyor — bu artık
// gerçek bir güvenlik sınırı, öncekinin aksine.
//
// Aynı güncellemeyle İKAS bağlantı bilgileri (mağaza adı, client id, client secret)
// artık öncelikle Firestore'dan (config/ikasAyarlari + config/ikasAyarlariGizli) okunuyor
// — uygulama içindeki "İKAS Ayarları" formundan yönetilebilsin diye. Firestore'da henüz
// ayar girilmemişse eski Vercel env değişkenlerine (IKAS_STORE_NAME vb.) düşülüyor, geçiş
// sırasında hiçbir şey bozulmasın diye.

// firebase-admin v14+ modüler API kullanıyor — eski admin.apps/admin.auth()/admin.firestore()
// namespace'i artık yok, getApps()/getAuth()/getFirestore() ile çağrılıyor (client SDK'nın
// modüler yapısıyla aynı desen).
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 env değişkeni eksik.');
  const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return initializeApp({ credential: cert(serviceAccount) });
}

async function verifyCaller(req, app) {
  const authHeader = req.headers['authorization'] || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) throw Object.assign(new Error('Giriş yapmadan bu işlem yapılamaz.'), { status: 401 });
  try {
    return await getAuth(app).verifyIdToken(m[1]);
  } catch (err) {
    throw Object.assign(new Error('Oturum geçersiz/süresi dolmuş, tekrar giriş yap.'), { status: 401 });
  }
}

let cachedToken = null; // { accessToken, expiresAt } — sadece warm invocation'lar arası yaşar

async function getIkasCredentials(app) {
  const db = getFirestore(app);
  const [ayarSnap, gizliSnap] = await Promise.all([
    db.doc('config/ikasAyarlari').get(),
    db.doc('config/ikasAyarlariGizli').get(),
  ]);
  const ayar = ayarSnap.exists ? ayarSnap.data() : {};
  const gizli = gizliSnap.exists ? gizliSnap.data() : {};
  return {
    storeName: ayar.storeName || process.env.IKAS_STORE_NAME,
    clientId: ayar.clientId || process.env.IKAS_CLIENT_ID,
    clientSecret: gizli.clientSecret || process.env.IKAS_CLIENT_SECRET,
  };
}

async function getIkasToken(app) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
  }

  const { storeName, clientId, clientSecret } = await getIkasCredentials(app);
  if (!storeName || !clientId || !clientSecret) {
    throw new Error('İKAS bağlantı bilgileri eksik (Mağaza Adı / Client ID / Client Secret) — "İKAS Ayarları" formunu doldur.');
  }

  const tokenUrl = `https://${storeName}.myikas.com/api/admin/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok || !json || !json.access_token) {
    throw new Error(`İKAS token alınamadı (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + Number(json.expires_in || 14400) * 1000,
  };
  return cachedToken.accessToken;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Sadece POST desteklenir.' });
    return;
  }

  let app;
  try {
    app = getAdminApp();
  } catch (err) {
    res.status(500).json({ error: 'Sunucu yapılandırması eksik: ' + err.message });
    return;
  }

  try {
    await verifyCaller(req, app);
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
    return;
  }

  let query, variables;
  try {
    ({ query, variables } = req.body || {});
  } catch (_) {
    res.status(400).json({ error: 'İstek gövdesi okunamadı (geçersiz JSON).' });
    return;
  }
  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'İstek gövdesinde { query, variables } bekleniyor.' });
    return;
  }

  // Faz 1 koruması — dosya başındaki açıklamaya bakın.
  if (/\bmutation\b/i.test(query)) {
    res.status(403).json({ error: 'Bu fazda sadece okuma (query) destekleniyor; mutation reddedildi.' });
    return;
  }

  let token;
  try {
    token = await getIkasToken(app);
  } catch (err) {
    res.status(502).json({ error: 'İKAS ile bağlantı kurulamadı: ' + err.message });
    return;
  }

  try {
    const ikasRes = await fetch('https://api.myikas.com/api/v1/admin/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const text = await ikasRes.text();
    res.status(ikasRes.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'İKAS GraphQL isteği başarısız: ' + err.message });
  }
};
