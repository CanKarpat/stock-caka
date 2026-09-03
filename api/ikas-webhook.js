// İKAS sipariş webhook alıcısı — api/ikas.js'den AYRI bir dosya, çünkü kimlik doğrulama
// modeli tamamen farklı: burada İKAS bizi çağırıyor, giriş yapmış bir Firebase kullanıcısı
// değil — api/ikas.js'deki "Authorization: Bearer <idToken>" doğrulaması burada geçerli değil.
//
// GÜVENLİK NOTU: gelen webhook body'sinde bir "signature" alanı VAR (2026-08-10'da ilk
// gerçek teslimatla keşfedildi) — İKAS aslında imzalıyor olabilir, ama imzalama algoritması/
// anahtarı dokümante değil, bu yüzden şimdilik doğrulayamıyoruz. Tek savunma hattımız hâlâ,
// webhook kaydı sırasında URL'ye gömülen tahmin edilemez bir "secret" query param'ı (bkz.
// index.html: setupIkasWebhook()). İleride signature alanının nasıl hesaplandığı bulunursa
// (İKAS destek ekibine sorulabilir) buraya gerçek doğrulama eklenebilir.
//
// Sipariş payload şekli 2026-08-10'da ilk gerçek teslimatla DOĞRULANDI: dış zarf şöyle —
//   { authorizedAppId, createdAt (webhook olay zamanı), data: "<JSON STRING>", id (webhook
//     OLAY ID'si, sipariş ID'si DEĞİL), isPrivateApp, merchantId, scope, signature }
// Asıl sipariş, `data` alanında JSON-STRING olarak geliyor (obje değil, önce JSON.parse
// gerekiyor!) — parse edilince: { id (gerçek sipariş ID'si), orderNumber, orderedAt,
// totalPrice, totalFinalPrice, currencyCode, status, orderLineItems: [{ id, price,
// finalPrice, quantity, variant: { id, productId, name, sku, ... } }] }.
function parseOrderData(payload) {
  if (payload && typeof payload.data === 'string') {
    try { return JSON.parse(payload.data); } catch (_) { return null; }
  }
  if (payload && payload.data && typeof payload.data === 'object') return payload.data;
  return null;
}

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

let cachedKategoriYolMap = null; // { map, fetchedAt } — public/index.html'deki kategoriYolMap'in sunucu eşleniği
async function getKategoriYolMap(db) {
  const now = Date.now();
  if (cachedKategoriYolMap && now - cachedKategoriYolMap.fetchedAt < 5 * 60 * 1000) return cachedKategoriYolMap.map;
  const snap = await db.doc('config/kategoriAgaci').get();
  const liste = snap.exists ? (snap.data().liste || []) : [];
  const map = {};
  liste.forEach(k => { map[k.id] = k.yol; });
  cachedKategoriYolMap = { map, fetchedAt: now };
  return map;
}

// public/index.html'deki syncMagazaUrunu()'nun sunucu tarafı (Admin SDK) eşleniği — satış
// sonrası stok düştüğünde müşteriye açık magaza_urunler koleksiyonunun da anında (admin
// panele girip elle kaydetmeyi beklemeden) güncel kalması için. Aynı filtre kuralı: sadece
// miktar>=1 olan varyantlar listelenir, satılabilir hiçbir varyant kalmadıysa ürün dokümanı
// tamamen silinir.
async function syncMagazaUrunuAdmin(db, productId, p, kategoriYolMap) {
  const ref = db.collection('magaza_urunler').doc(String(productId));
  const varyantlar = ((p.durum || 'Yayında') === 'Yayında' ? (p.variants || []) : [])
    .filter(v => Number(v.miktar || 0) >= 1)
    .map(v => ({
      sku: v.sku || '',
      renk: v.renk || '',
      beden: v.beden || '',
      gorselUrl: v.gorselUrl || '',
      gorselUrlArka: v.gorselUrlArka || '',
      bd: !!v.bd,
    }));
  if (!varyantlar.length) {
    await ref.delete().catch(() => {});
    return;
  }
  await ref.set({
    ad: p.ad || '',
    kod: p.kod || '',
    satisFiyati: Number(p.satis || 0),
    indirimliFiyat: Number(p.indirimli || 0),
    kategoriler: (p.ikasKategoriler || []).map(k => (kategoriYolMap && kategoriYolMap[k.id]) || k.name).filter(Boolean),
    varyantlar,
    guncellendi: FieldValue.serverTimestamp(),
  });
}

function pickLineSku(item) {
  return (item.variant && item.variant.sku) || item.sku || null;
}
function pickLineQty(item) {
  return Number(item.quantity ?? 1) || 1;
}
function pickLinePrice(item) {
  // finalPrice, indirim varsa gerçek satış fiyatını yansıtır; price yoksa ona düş.
  const p = item.finalPrice ?? item.price ?? 0;
  return Number(p) || 0;
}
function pickLineName(item) {
  return (item.variant && item.variant.name) || null;
}

// Depozito webhook eşleştirmesi — showroom-appon (appointment-showroom-gracecode) için.
// Showroom randevu sitesi statik bir İKAS sepet linki kullanıyor, müşterinin depozitoyu
// gerçekten ödeyip ödemediğini bilmiyor. Depozito da normal bir İKAS siparişi olarak bu
// webhook'u tetiklediği için, SKU'su "depozito" olan bir sipariş PAID durumuna geçtiğinde
// randevular koleksiyonuna geri yazıyoruz.
//
// 2026-09-03'te GERÇEK bir test siparişiyle (orderNumber 1155) doğrulandı — TAHMİN DEĞİL:
// - orderData.customer.email / orderData.customer.phone — phone "+905389657226" formatında
//   (E.164'e yakın, ülke koduyla, boşluksuz). billingAddress.phone da aynı değeri taşıyor,
//   customer.phone boşsa oraya düşülüyor.
// - orderData.orderPaymentStatus === 'PAID' — ödemenin gerçekten tamamlandığını gösteren
//   alan bu. Sipariş OLUŞTUĞU anda (store/order/created) ödeme henüz onaylanmamış da olabilir
//   diye, sadece PAID ise randevuyu işaretliyoruz.
// - orderLineItems[].variant.sku === 'depozito' — showroom'daki depozito ürününün gerçek SKU'su.
function normalizeTelefon(s) {
  // Türkiye cep telefonu: +90/0 önekinden ve ayraçlardan (boşluk, tire) bağımsız olsun diye
  // sadece rakamları alıp SON 10 haneyi karşılaştırıyoruz (5XX XXX XX XX) — randevu formuna
  // müşterinin serbest metin olarak yazdığı telefonla İKAS'ın kendi formatı birebir aynı
  // olmayabilir, bu normalize olmadan neredeyse hiç eşleşmez.
  const digits = String(s || '').replace(/\D/g, '');
  return digits.slice(-10);
}
function normalizeEposta(s) {
  return String(s || '').trim().toLowerCase();
}

async function depozitoEslestirVeIsaretle(db, orderData, orderNumber) {
  const ayarSnap = await db.doc('config/randevuAyarlari').get();
  const depozitoSku = (ayarSnap.exists && ayarSnap.data().depozitoSku) || 'depozito';

  const lineItems = orderData.orderLineItems || [];
  const depozitoVarMi = lineItems.some(li => {
    const sku = li && li.variant && li.variant.sku;
    return sku && String(sku).trim().toLowerCase() === String(depozitoSku).trim().toLowerCase();
  });
  if (!depozitoVarMi) return;

  if (orderData.orderPaymentStatus !== 'PAID') {
    console.error(`[ikas-webhook] Depozito ürünü siparişte var ama ödeme durumu PAID değil (orderNumber=${orderNumber}, orderPaymentStatus=${orderData.orderPaymentStatus}) — randevu işaretlenmedi.`);
    return;
  }

  const customer = orderData.customer || {};
  const musteriEposta = normalizeEposta(customer.email);
  const musteriTelefon = normalizeTelefon(customer.phone || (orderData.billingAddress && orderData.billingAddress.phone));
  if (!musteriEposta && !musteriTelefon) {
    console.error(`[ikas-webhook] Depozito ödemesi geldi ama siparişte müşteri e-posta/telefonu yok, eşleştirilemedi (orderNumber=${orderNumber}).`);
    return;
  }

  // randevular koleksiyonu küçük (bkz. feedback_live_firebase hafıza notu, stok koleksiyonu
  // için de aynı gerekçeyle bu dosyada tam okuma yapılıyor). Firestore'un `!=` sorgusu, alan
  // hiç YOKSA dokümanı sonuçtan DIŞLAR — yeni randevularda depozitoOdendi hiç set edilmediği
  // için (alan yok, false değil) bir `where('depozitoOdendi','!=',true)` sorgusu bu yüzden
  // TÜM yeni randevuları yanlışlıkla atlardı. Bunun yerine son 200 randevu çekilip elle
  // filtreleniyor — en yeni oluşturulan zaten sıralamada ilk sırada.
  const snap = await db.collection('randevular').orderBy('olusturulmaTarihi', 'desc').limit(200).get();
  let eslesen = null;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.depozitoOdendi === true) continue;
    const epostaEslesiyor = musteriEposta && normalizeEposta(d.musteriEposta) === musteriEposta;
    const telefonEslesiyor = musteriTelefon && normalizeTelefon(d.musteriTelefon) === musteriTelefon;
    if (epostaEslesiyor || telefonEslesiyor) { eslesen = doc; break; }
  }
  if (!eslesen) {
    console.error(`[ikas-webhook] Depozito ödemesi geldi (orderNumber=${orderNumber}) ama eşleşen randevu bulunamadı. eposta=${musteriEposta} telefon=${musteriTelefon}`);
    return;
  }

  await eslesen.ref.set({
    depozitoOdendi: true,
    depozitoOdemeTarihi: FieldValue.serverTimestamp(),
    depozitoSiparisNo: orderNumber,
  }, { merge: true }); // merge:true → İKAS aynı webhook'u tekrar gönderirse (bilinen davranış) sorun olmaz
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
    // Güvenlik ağı: data hiç parse edilemezse ham payload'a düş (yine de hamVeri kaybolmasın).
    const orderData = parseOrderData(payload) || payload;
    const orderId = orderData.id || null;
    const orderNumber = orderData.orderNumber || null;
    const orderedAt = orderData.orderedAt || null;
    const lineItems = orderData.orderLineItems || [];

    // Depozito eşleştirmesi ana satış/stok akışından bağımsız — ayrı try/catch, bir hata
    // olsa bile satış kaydı/stok düşümü akışını bozmasın (magaza_urunler senkronuyla aynı
    // izolasyon deseni, aşağıda).
    try {
      await depozitoEslestirVeIsaretle(db, orderData, orderNumber);
    } catch (err) {
      console.error('[ikas-webhook] Depozito eşleştirme hatası:', err);
    }

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
      // Ürün adı önce KENDİ Firestore'umuzdaki (SKU eşleşen) kayıttan, o yoksa İKAS'ın
      // webhook'ta zaten gönderdiği variant.name'den alınır — SKU henüz yerel katalogda
      // yoksa/eşleşmiyorsa bile satır boş görünmesin diye.
      const urunAdi = (productId ? productNameById.get(productId) : null) || (li ? pickLineName(li) : null) || '';
      yazilacaklar.push({
        docId: `${orderId || 'bilinmeyen'}_${index}`,
        data: {
          sku: skuTemiz,
          urunAdi,
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
      const guncelUrun = await db.runTransaction(async (tx) => {
        const ref = db.collection('stok').doc(productId);
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const data = snap.data();
        const variants = data.variants || [];
        items.forEach(({ sku, adet }) => {
          const v = variants.find(v => String(v.sku || '').trim() === sku);
          if (v) v.miktar = Number(v.miktar || 0) - adet;
        });
        tx.update(ref, { variants });
        return { ...data, variants };
      });
      // Stok düşüşü sonrası magaza_urunler'i de anında güncelle (bkz. syncMagazaUrunuAdmin) —
      // ayrı bir hata olsa bile ana webhook akışını (satış kaydı) bozmasın diye kendi try/catch'i var.
      if (guncelUrun) {
        try {
          const kategoriYolMap = await getKategoriYolMap(db);
          await syncMagazaUrunuAdmin(db, productId, guncelUrun, kategoriYolMap);
        } catch (err) {
          console.error('magaza_urunler senkron hatası (productId=' + productId + '):', err);
        }
      }
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
