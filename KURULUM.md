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

## Sorun mu var?

Herhangi bir adımda takılırsan bu sohbette "şurada takıldım" diye yaz, yardım ederim!
