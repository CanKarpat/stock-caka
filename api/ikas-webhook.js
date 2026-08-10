// İKAS sipariş webhook alıcısı — api/ikas.js'den AYRI bir dosya, çünkü kimlik doğrulama
// modeli tamamen farklı: burada İKAS bizi çağırıyor, giriş yapmış bir Firebase kullanıcısı
// değil — api/ikas.js'deki "Authorization: Bearer <idToken>" doğrulaması burada geçerli değil.
//
// GÜVENLİK NOTU: İKAS'ın webhook çağrılarını imzaladığına dair (HMAC/imza header'ı) hiçbir
// dokümantasyon bulunamadı (ikas.dev, 2026-08 itibarıyla sadece "3 kez tekrar dener" diyor,
// imzalamadan bahsetmiyor). Bu yüzden tek savunma hattımız, webhook kaydı sırasında URL'ye
// gömülen tahmin edilemez bir "secret" query param'ı (bkz. index.html: setupIkasWebhook()).
// Gerçek bir webhook isteği geldiğinde Vercel loglarından TÜM header'lar bir kez incelenip
// İKAS'ın dokümante edilmemiş bir imza header'ı (ör. X-Ikas-Signature) gönderip göndermediği
// kontrol edilmeli — gönderiyorsa doğrulama buna göre sıkılaştırılmalı.
//
// Sipariş payload şekli DOĞRULANMADI — bu yüzden aşağıdaki pick*() yardımcıları birden
// fazla olası alan adını dener ve HER durumda ham payload'ı (hamVeri) da kaydeder; gerçek
// şekil netleşince (ilk canlı teslimatın Vercel loglarından/hamVeri'den incelenmesiyle)
// pick*() fonksiyonları düzeltilebilir.

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 env değişkeni eksik.');
  const serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return initializeApp({ credential: cert(serviceAccount) });
}

let cachedSecret = null; // { value, fetchedAt } — 5 dakika önbellek, cachedToken (api/ikas.js) ile aynı desen
async function getWebhookSecret(app) {
  const now = Date.now();
  if (cachedSecret && now - cachedSecret.fetchedAt < 5 * 60 * 1000) return cachedSecret.value;
  const db = getFirestore(app);
  const snap = await db.doc('config/ikasAyarlariGizli').get();
  const value = snap.exists ? snap.data().webhookSecret : null;
  cachedSecret = { value, fetchedAt: now };
  return value;
}

function pickOrderId(payload) {
  return payload.id || (payload.data && payload.data.id) || (payload.order && payload.order.id) || payload.orderId || null;
}
function pickOrderNumber(payload) {
  return payload.orderNumber || (payload.data && payload.data.orderNumber) || (payload.order && payload.order.orderNumber) || null;
}
function pickOrderedAt(payload) {
  return payload.orderedAt || (payload.data && payload.data.orderedAt) || (payload.order && payload.order.orderedAt) || null;
}
function pickLineItems(payload) {
  return payload.orderLineItems || (payload.data && payload.data.orderLineItems) || (payload.order && payload.order.orderLineItems) || payload.lineItems || [];
}
function pickLineSku(item) {
  return item.sku || (item.variant && item.variant.sku) || (item.productVariant && item.productVariant.sku) || null;
}
function pickLineQty(item) {
  const q = item.quantity ?? item.qty ?? item.amount ?? 1;
  return Number(q) || 1;
}
function pickLinePrice(item) {
  const p = item.price ?? item.finalPrice ?? item.unitPrice ?? item.sellPrice ?? 0;
  return Number(p) || 0;
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

  let beklenenSecret;
  try {
    beklenenSecret = await getWebhookSecret(app);
  } catch (err) {
    res.status(500).json({ error: 'Webhook secret okunamadı: ' + err.message });
    return;
  }
  const gelenSecret = (req.query && req.query.secret) || '';
  if (!beklenenSecret || gelenSecret !== beklenenSecret) {
    res.status(401).json({ error: 'Geçersiz webhook secret.' });
    return;
  }

  let payload;
  try {
    payload = req.body || {};
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch (err) {
    res.status(400).json({ error: 'İstek gövdesi okunamadı (geçersiz JSON).' });
    return;
  }

  // Kimlik doğrulama hatası dışında her zaman 200 dönmeye çalışıyoruz — aksi halde İKAS
  // gereksiz yere 3 kez daha aynı isteği tekrar dener.
  try {
    const db = getFirestore(app);
    const orderId = pickOrderId(payload);
    const orderNumber = pickOrderNumber(payload);
    const orderedAt = pickOrderedAt(payload);
    const lineItems = pickLineItems(payload);

    // stok koleksiyonunu SKU'ya göre belleğe al — pullIkasProducts()'ın (index.html) client
    // tarafında yaptığı SKU-eşleştirmesinin sunucu tarafındaki eşleniği. Koleksiyon küçük
    // olduğu için (bkz. feedback_live_firebase hafıza notu) her webhook çağrısında tek
    // seferlik tam okuma kabul edilebilir.
    const stokSnap = await db.collection('stok').get();
    const productsBySku = new Map(); // sku -> stok doküman ID'si
    const productNameById = new Map(); // stok doküman ID'si -> ürün adı
    stokSnap.forEach(d => {
      const data = d.data();
      productNameById.set(d.id, data.ad || '');
      (data.variants || []).forEach(v => {
        if (v.sku) productsBySku.set(String(v.sku).trim(), d.id);
      });
    });

    const satirlar = lineItems.length ? lineItems : [null]; // hiç satır yoksa bile ham payload'ı kaybetmeyelim
    const stokDusurmeGrup = new Map(); // productDocId -> [{sku, adet}]
    const yazilacaklar = [];

    satirlar.forEach((li, index) => {
      const sku = li ? pickLineSku(li) : null;
      const adet = li ? pickLineQty(li) : null;
      const fiyat = li ? pickLinePrice(li) : null;
      const skuTemiz = sku ? String(sku).trim() : null;
      const productId = skuTemiz ? productsBySku.get(skuTemiz) : null;
      if (productId && adet) {
        if (!stokDusurmeGrup.has(productId)) stokDusurmeGrup.set(productId, []);
        stokDusurmeGrup.get(productId).push({ sku: skuTemiz, adet });
      }
      yazilacaklar.push({
        docId: `${orderId || 'bilinmeyen'}_${index}`,
        data: {
          sku: skuTemiz,
          urunAdi: productId ? (productNameById.get(productId) || '') : '',
          adet: adet,
          fiyat: fiyat,
          ikasSiparisNo: orderNumber || null,
          tarih: orderedAt ? new Date(orderedAt) : FieldValue.serverTimestamp(),
          hamVeri: li !== null ? li : payload,
        },
      });
    });

    // Her ürün dokümanı için TEK transaction — aynı siparişte aynı üründen birden fazla
    // varyant satılmışsa (ör. 2 farklı beden) hepsini tek okuma/yazmada uygula, eş zamanlı
    // gelen başka bir webhook teslimatıyla yarış durumuna (race condition) düşmesin.
    for (const [productId, items] of stokDusurmeGrup) {
      await db.runTransaction(async (tx) => {
        const ref = db.collection('stok').doc(productId);
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data();
        const variants = data.variants || [];
        items.forEach(({ sku, adet }) => {
          const v = variants.find(v => String(v.sku || '').trim() === sku);
          if (v) v.miktar = Number(v.miktar || 0) - adet;
        });
        tx.update(ref, { variants });
      });
    }

    await Promise.all(yazilacaklar.map(({ docId, data }) =>
      db.collection('satislar').doc(docId).set(data, { merge: true })
    ));

    res.status(200).json({ ok: true, kayit: yazilacaklar.length });
  } catch (err) {
    // Kayıt sırasında beklenmedik bir hata olsa bile 200 dönüyoruz (İKAS'ın gereksiz yere
    // tekrar denemesini önlemek için) — ama hatayı Vercel loglarına düşürüyoruz.
    console.error('ikas-webhook işleme hatası:', err);
    res.status(200).json({ ok: false, error: err.message });
  }
};
