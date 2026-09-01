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
// Faz 2 (2026-08): köründen mutation reddi yerine dar bir beyaz liste var (aşağıda
// ALLOWED_MUTATIONS) — sadece belirli, incelenmiş mutation'lara izin veriliyor, geri
// kalan her şey hâlâ reddediliyor. YENİ bir mutation eklemeden önce mutlaka bir
// introspection sorgusuyla ({ __type(name:"X"){fields{name}} }) gerçek adını/girdi
// şeklini doğrula, sonra ALLOWED_MUTATIONS'a ekle ve hangi alanları (özellikle alış
// fiyatını) ASLA göndermediğini yorum olarak yaz.
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

// Beyaz listedeki mutation'lar dışında hiçbir yazma işlemine izin verilmiyor.
// index.html'den gönderilen mutation'lar İSİMSİZ kalmalı (`mutation { ... }`,
// `mutation SaveX(...) { ... }` DEĞİL) — isimli bir operasyon da aşağıdaki
// "isim(" deseniyle eşleşip beyaz listeye eklenmesi gerekir, kafa karıştırır.
const ALLOWED_MUTATIONS = new Set([
  'saveProduct',             // yeni ürün gönderme / var olan ürüne varyant ekleme
  'saveVariantPrices',       // fiyat push — DOĞRULANDI (ikas.dev)
  'saveProductStockLocations', // stok push — DOĞRULANDI (2026-08-27, introspection'la: "bulkUpdateProductStock"
                                // hiç yoktu, "bulkUpdateProducts" da yanlış adaydı (tüm ürünü ister) — gerçek,
                                // hafif karşılığı bu; SaveStockLocationsInput{productStockLocationInputs:[...]})
  'saveWebhook',             // webhook kurulum — DOĞRULANDI
  'deleteWebhook',           // webhook kaldırma — DOĞRULANDI
]);

let cachedToken = null; // { accessToken, expiresAt, storeName, clientId, clientSecret } — sadece warm invocation'lar arası yaşar

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
  const { storeName, clientId, clientSecret } = await getIkasCredentials(app);
  if (!storeName || !clientId || !clientSecret) {
    throw new Error('İKAS bağlantı bilgileri eksik (Mağaza Adı / Client ID / Client Secret) — "İKAS Ayarları" formunu doldur.');
  }

  // Önbellekteki token BAŞKA bir mağaza/kimlik bilgisi için alınmışsa (ör. test mağazasından
  // gerçek mağazaya geçildiyse) süresi dolmamış olsa bile geçersiz sayılır — aksi halde "sıcak"
  // bir Vercel fonksiyon örneği, kimlik bilgileri Firestore'da değişmiş olsa bile eski mağazanın
  // token'ını sessizce kullanmaya devam ederdi (2026-09'da canlı geçiş sırasında keşfedildi:
  // "Yenile" hep eski mağazanın verisini getiriyordu).
  const kimlikDegisti = !cachedToken || cachedToken.storeName !== storeName || cachedToken.clientId !== clientId || cachedToken.clientSecret !== clientSecret;
  if (!kimlikDegisti && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
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
    storeName, clientId, clientSecret,
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

  // Faz 2 mutation beyaz listesi — dosya başındaki açıklamaya bakın.
  // DİKKAT (2026-08-14'te bulundu, 2026-08-27'de düzeltildi): eskiden /\bmutation\b/i sorgu
  // METNİNİN HERHANGİ BİR YERİNDE "mutation" kelimesi geçip geçmediğine bakıyordu — bu da
  // ör. `{ __type(name:"Mutation"){...} }` gibi zararsız bir introspection sorgusunu (tip adı
  // olarak "Mutation" string'i geçtiği için) yanlışlıkla engelliyordu. Gerçek bir mutation
  // operasyonu GraphQL'de sadece sorgunun EN BAŞINDA "mutation" anahtar kelimesiyle başlar —
  // bu uygulamanın gönderdiği tüm mutation'lar da hep `mutation($input: ...` şeklinde, hiç
  // isimsiz/başka türlü değil. Bu yüzden kontrol artık sadece BAŞLANGIÇTA arıyor.
  if (/^\s*mutation\b/i.test(query)) {
    // Sorgudaki TÜM "isim(" çağrılarını çıkar — sadece ilk eşleşmeye bakmak, izinli
    // bir mutation'ın yanına gizlice ikinci, izinsiz bir mutation eklemeyi (query
    // smuggling) mümkün kılar. 'mutation'/'query' kendisi de bu desenle eşleşebilir
    // (ör. `mutation($input: X!) { ... }` içindeki "mutation(") — bunlar GraphQL'in
    // ayrılmış operasyon anahtar kelimeleri, gerçek bir alan/mutation adı değil, o
    // yüzden listeden çıkarılıyor.
    const GRAPHQL_OP_KEYWORDS = new Set(['query', 'mutation', 'subscription']);
    const calledFields = [...query.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map(m => m[1])
      .filter(name => !GRAPHQL_OP_KEYWORDS.has(name));
    const disallowed = calledFields.filter(name => !ALLOWED_MUTATIONS.has(name));
    if (!calledFields.length || disallowed.length) {
      res.status(403).json({ error: `Bu mutation'a izin verilmiyor: ${disallowed.join(', ') || '(tanınmayan)'}` });
      return;
    }
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
