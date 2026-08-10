// Thin server-side proxy to the İKAS Admin GraphQL API.
//
// Why this exists: İKAS's docs explicitly disallow calling their API directly from a
// browser, and IKAS_CLIENT_SECRET must never ship to the public static frontend. This
// function is the ONLY place that ever sees it.
//
// Design: intentionally "dumb". It knows nothing about products, variants, or
// Firestore — it gets a bearer token (cached in memory per warm instance) and forwards
// {query, variables} to İKAS, returning İKAS's raw JSON back unchanged. All İKAS-shape
// <-> Firestore-shape mapping stays in public/index.html, next to the existing
// processIkasFiles()/runIkasSync() mapping logic — see ikasApi() there.
//
// Faz 1 koruması (GERÇEK BİR GÜVENLİK SINIRI DEĞİL — aşağıdaki APP_SHARED_SECRET
// kontrolüne bakın): mutation'lar tamamen reddediliyor. Yazma yolu kasıtlı olarak
// tasarlanana kadar salt okunur. Bu kontrolü sadece o iş yapılırken kaldırın/gevşetin.

let cachedToken = null; // { accessToken, expiresAt } — sadece warm invocation'lar arası yaşar;
                         // cold start'ta kaybolur, bu sadece bir ekstra token isteğine mal olur.

async function getIkasToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
  }

  const { IKAS_STORE_NAME, IKAS_CLIENT_ID, IKAS_CLIENT_SECRET } = process.env;
  if (!IKAS_STORE_NAME || !IKAS_CLIENT_ID || !IKAS_CLIENT_SECRET) {
    throw new Error('IKAS_STORE_NAME / IKAS_CLIENT_ID / IKAS_CLIENT_SECRET env değişkenleri eksik.');
  }

  const tokenUrl = `https://${IKAS_STORE_NAME}.myikas.com/api/admin/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: IKAS_CLIENT_ID,
    client_secret: IKAS_CLIENT_SECRET,
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

  // İstismar caydırıcı — GERÇEK GÜVENLİK DEĞİL. Bu site tamamen statik/herkese açık,
  // giriş sistemi yok; bu header değeri index.html kaynağında da düz metin olarak
  // duruyor, devtools açan herkes görebilir. Firestore kurallarımızla aynı güven modeli
  // (allow read, write: if true) — amaç kaza/otomatik istismarı (bot, crawler) durdurmak,
  // kararlı bir saldırganı değil.
  const expected = process.env.APP_SHARED_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'Sunucuda APP_SHARED_SECRET tanımlı değil.' });
    return;
  }
  if (req.headers['x-app-secret'] !== expected) {
    res.status(401).json({ error: 'Yetkisiz.' });
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

  // Faz 1 koruması — dosya başındaki açıklamaya bakın. Basit bir alt-metin kontrolü,
  // güvenlik sınırı değil, sadece salt-okunur fazdayken yanlışlıkla/deneysel bir
  // yazma isteğinin tetiklenmesini engelliyor.
  if (/\bmutation\b/i.test(query)) {
    res.status(403).json({ error: 'Bu fazda sadece okuma (query) destekleniyor; mutation reddedildi.' });
    return;
  }

  let token;
  try {
    token = await getIkasToken();
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
