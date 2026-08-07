#  DBML ERD Viewer

DBML metnini React Flow üzerinde otomatik ELK yerleşimiyle salt-okunur ER diyagramı olarak gösterir.

## Çalıştırma

```bash
npm install
npm run dev
```

`src/` altındaki `.dbml` dosyaları sol menüde listelenir. Yeni dosya ekleyebilir veya soldan yükleyebilirsiniz.

Sağ menüden şema/tablo/kolon arayabilir, şema başına tablo sayılarını görebilirsiniz.
Çizgi veya tablo üzerine gelince bağlantılar vurgulanır; tablo notları başlıktaki ikonla okunur.

## Google Drive

Kısıtlı Drive dosyalarını Google hesabınla açmak için:

1. [Google Cloud Console](https://console.cloud.google.com/) üzerinde proje oluştur
2. **Google Drive API** ve **Google Picker API** etkinleştir
3. **OAuth 2.0 Client ID** (Web application) oluştur  
   - Authorized JavaScript origins: `http://localhost:5173` (ve prod URL’in)
4. **API Key** oluştur
5. Proje ayarlarından **Project number** değerini kopyala (App ID)
6. `.env.example` dosyasını `.env` olarak kopyala ve doldur:

```bash
cp .env.example .env
```

```env
VITE_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
VITE_GOOGLE_API_KEY=...
VITE_GOOGLE_APP_ID=1234567890
```

7. `npm run dev` yeniden başlat  
8. Sol menüden **Google Drive** → Google ile giriş → dosya seç

Drive’da dosyayı **Kısıtlı** paylaşımda tutup yalnızca istediğin Google hesaplarına görüntüleyici verebilirsin; uygulama, giriş yapan kullanıcının erişebildiği dosyaları açar.

## Desteklenen DBML yapıları

- `Table`
- `Enum` tanımları (alan tipi üzerine gelince değerler gösterilir)
- Alan tipleri ve `[pk, not null, unique, increment, default, note]`
- Tablo `Note`
- Dışarıda tanımlanan `Ref:` ilişkileri
- Kolon içinde `[ref: > table.field]` ilişkileri
- `>`, `<`, `-`, `<>` kardinaliteleri

Bileşik foreign key ifadeleri bu hafif tarayıcı parser'ında uyarı üreterek atlanır.
