# Abiye Stok Yönetimi — Kurulum Rehberi

Merhaba! Bu rehberi adım adım takip edersen 15 dakikada uygulamanı yayına alabilirsin. Hiç teknik bilgi gerekmez.

---

## 1. Adım — Firebase Kurulumu (ücretsiz veritabanı)

1. https://console.firebase.google.com adresine git
2. Google hesabınla giriş yap
3. **"Add project"** butonuna tıkla
4. Proje adı gir (örn. `abiye-stok`) → Continue → Continue → Create project
5. Sol menüden **"Firestore Database"** → **"Create database"** → **"Start in test mode"** → Next → Enable
6. Sol üstteki dişli (⚙️) ikonuna tıkla → **"Project settings"**
7. Aşağı kaydır → **"Your apps"** bölümünde **`</>`** (Web) ikonuna tıkla
8. Uygulama takma adı gir (örn. `web`) → **"Register app"**
9. Açılan `firebaseConfig` bilgilerini bir yere kopyala (birazdan lazım olacak)

---

## 2. Adım — Uygulamayı Vercel'e Yükle (ücretsiz hosting)

### A) GitHub ile (önerilen)

1. https://github.com adresine git → üye ol / giriş yap
2. Sağ üstte **"+"** → **"New repository"** → İsim: `abiye-stok` → Public → Create
3. Bu klasördeki dosyaları GitHub'a yükle:
   - `public/index.html`
   - `public/manifest.json`
   - `public/sw.js`
   - `vercel.json`
4. https://vercel.com adresine git → GitHub ile giriş yap
5. **"Add New → Project"** → GitHub reposunu seç → **"Deploy"**
6. Birkaç saniye sonra sana bir link verecek: `abiye-stok.vercel.app` ✅

### B) Vercel CLI ile (daha hızlı)

```bash
npm i -g vercel
cd abiye-stok
vercel --prod
```

---

## 3. Adım — Firebase Bağlantısını Yap

1. Vercel'deki linke git (örn. `abiye-stok.vercel.app`)
2. Açılan **Firebase bağlantısı** modalında 1. adımda kopyaladığın bilgileri gir:
   - API Key
   - Auth Domain
   - Project ID
   - App ID
3. **"Bağlan"** butonuna tıkla
4. ✅ "Canlı" yazısı görünürse bağlantı tamam!

---

## 4. Adım — Çalışanlarınla Paylaş

Sadece Vercel linkini (örn. `abiye-stok.vercel.app`) çalışanlarına WhatsApp'tan gönder.  
Herkes aynı anda aynı veriyi görür ve düzenleyebilir — otomatik senkronize olur.

### Telefona uygulama olarak eklemek için:
- **iPhone**: Safari'de aç → Paylaş butonu → "Ana Ekrana Ekle"
- **Android**: Chrome'da aç → Üç nokta menü → "Ana ekrana ekle"

---

## Firestore Güvenlik Kuralları (isteğe bağlı)

Test modunda herkes okuyup yazabilir. İleride kısıtlamak istersen Firebase Console → Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /stok/{document} {
      allow read, write: if true; // Şimdilik herkese açık
    }
  }
}
```

---

## İKAS API Entegrasyonu (isteğe bağlı, ileri seviye)

Mağaza adı / Client ID / Client Secret artık **uygulama içinden** yönetiliyor: Stok Listesi sayfasında **"İKAS Ayarları"** butonuna tıkla, formu doldur, Kaydet — Vercel'e tekrar deploy etmene gerek yok. Bu bilgiler Firestore'da `config/ikasAyarlari` (mağaza adı, client id) ve `config/ikasAyarlariGizli` (client secret) dokümanlarında tutulur; client secret hiçbir zaman geri okunup forma basılmaz, boş bırakırsan mevcut değer korunur.

Formu kaydedebilmen için giriş yapmış olman yeterli — ama `/api/ikas.js` sunucu tarafında bu girişin gerçekten geçerli olduğunu doğrulayabilmesi (Firebase ID token doğrulaması) için **bir kere** şu adımı yapman gerekiyor:

1. Firebase Console → ⚙️ Project Settings → **Service Accounts** → **Generate new private key** (bir `.json` dosyası iner).
2. Bu dosyayı tek satırlık base64'e çevir (macOS'un varsayılan `base64` komutu satırları kırdığı için normal `base64` KULLANMA):
   ```
   openssl base64 -A -in indirilen-dosya.json
   ```
3. Çıkan uzun tek satırı Vercel projenin **Settings → Environment Variables** bölümüne `FIREBASE_SERVICE_ACCOUNT_B64` adıyla ekle.
4. Deployments → ⋯ → **Redeploy**.

Bu adımı tamamladıktan sonra "İKAS Bağlantı Testi" ve "İKAS'tan Çek (API)" butonları hem giriş kontrolünü hem de İKAS bağlantısını uygulama içinden yönetilen ayarlarla kullanabilir.

Eski `IKAS_STORE_NAME` / `IKAS_CLIENT_ID` / `IKAS_CLIENT_SECRET` env değişkenleri hâlâ çalışır ama artık sadece **yedek**: Firestore'da "İKAS Ayarları" formundan bir değer girilmemişse bunlara düşülür. `APP_SHARED_SECRET` artık hiç kullanılmıyor (gerçek giriş sistemi geldiği için kaldırıldı) — Vercel'de duruyorsa silebilirsin, zararı yok.

---

## Sorun mu var?

Herhangi bir adımda takılırsan bu sohbette "şurada takıldım" diye yaz, yardım ederim!
