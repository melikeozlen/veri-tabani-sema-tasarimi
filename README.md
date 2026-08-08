# ER Diyagramı

DBML metnini React Flow üzerinde otomatik ELK yerleşimiyle salt-okunur varlık-ilişki (ER) diyagramı olarak görüntüler. Amaç: veritabanı şemalarını görsel olarak incelemek ve paylaşmak.

Kimlik doğrulama Google Sheet üzerinden yapılır; yetkili Drive klasörlerindeki `.dbml` / `.txt` dosyaları sunucu (service account) ile okunur.

> **Kendi Google Drive / Sheet entegrasyonunuzu kurmak için:**  
> adım adım rehber → [`docs/KURULUM.md`](docs/KURULUM.md)

## Çalıştırma

```bash
cp .env.example .env
# .env ve secrets/service-account.json doldur — detay: docs/KURULUM.md
npm install
npm run dev
```

`npm run dev` hem API (`:3001`) hem Vite (`:5173`) başlatır. Vite `/api` isteklerini API’ye proxy’ler.

## Google Sheet = DB

Spreadsheet’te şu sayfalar olmalı (başlık satırı zorunlu). Tam kurulum ve paylaşım adımları için [`docs/KURULUM.md`](docs/KURULUM.md).

### Kullanicilar

| username | password_hash | is_super_admin | aktif |
|----------|---------------|----------------|-------|
| admin | `$2a$12$...` | TRUE | TRUE |
| ayse | `$2a$12$...` | FALSE | TRUE |

Şifre hash üretmek:

```bash
npm run hash-password -- "sifreniz"
```

Çıktıyı `password_hash` sütununa yapıştırın. Düz metin şifre saklamayın.

### Ekipler

| team_id | team_name |
|---------|-----------|
| crm | CRM |

### EkipUyeleri

| team_id | username |
|---------|----------|
| crm | ayse |

### Klasorler

| folder_id | label | drive_folder_id |
|-----------|-------|-----------------|
| sales | Satış | 1abcDriveFolderId |

`drive_folder_id`: Drive klasörünün URL’sindeki ID.

### Yetkiler

| folder_id | grantee_type | grantee_id |
|-----------|--------------|------------|
| sales | user | ayse |
| sales | team | crm |

- `grantee_type`: `user` veya `team` (Türkçe: `kullanici` / `ekip` de kabul)
- Super admin (`is_super_admin=TRUE`) tüm klasörleri görür

## Google Cloud / Service Account

Özet (detay: [`docs/KURULUM.md`](docs/KURULUM.md)):

1. Google Cloud’da proje oluştur
2. **Google Sheets API** ve **Google Drive API** etkinleştir
3. Service account oluştur → JSON anahtar indir → `secrets/service-account.json`
4. Sheet’i service account e-postasıyla **Düzenleyici** paylaş (yönetim ekranı yazdığı için Viewer yetmez)
5. Drive klasörlerini aynı e-postayla **Görüntüleyici** paylaş (Kaydet için **Düzenleyici**)
6. `.env` içinde `GOOGLE_SHEET_ID` ve `SESSION_SECRET` doldur

```env
PORT=3001
SESSION_SECRET=...
GOOGLE_SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/service-account.json
```

**Önemli:** Service account anahtarı yalnızca sunucu `.env` / `secrets/` içinde tutulur. `VITE_*` ile tarayıcıya konmaz.

## Oturum

- Login zorunlu; giriş yoksa login ekranı
- JWT oturum token’ı IndexedDB’de saklanır
- Çıkış sol panelden yapılır

## Desteklenen DBML yapıları

- `Table`
- `Enum` tanımları (alan tipi üzerine gelince değerler gösterilir)
- Alan tipleri ve `[pk, not null, unique, increment, default, note]`
- Tablo `Note`
- Dışarıda tanımlanan `Ref:` ilişkileri
- Kolon içinde `[ref: > table.field]` ilişkileri
- `>`, `<`, `-`, `<>` kardinaliteleri

Bileşik foreign key ifadeleri bu hafif tarayıcı parser'ında uyarı üreterek atlanır.
