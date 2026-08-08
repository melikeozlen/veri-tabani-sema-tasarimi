# Kurulum Rehberi — ER Diyagramı (Google Drive / Sheet)

Bu uygulama **sizin** Google hesabınıza bağlanır. Başkasının Sheet/Drive’ını kullanmazsınız.

Akış:

1. Google Cloud’da service account oluşturursunuz  
2. Veritabanı olarak bir Google Sheet hazırlarsınız  
3. DBML dosyalarının olduğu Drive klasörlerini paylaşırsınız  
4. `.env` (veya sunucu Variables) doldurursunuz  
5. Uygulamayı çalıştırır / deploy edersiniz  

Kod içinde Drive ID sabitlemeye gerek yoktur; her şey Sheet + `.env` ile yönetilir.

### Firma logosu (opsiyonel)

Yetkili diyagram klasörünün yanında bir `LOGO` klasörüne (ör. `ER/LOGO/logo-light.png`) veya klasör köküne koyun. `LOGO` klasörünü de service account ile paylaşın. Detay: `public/brand/README.md`.

---

## 0) Önkoşullar

- Node.js 18+ (tercihen 20+)
- Google hesabı
- Repo klonu

```bash
git clone <repo-url>
cd <proje-klasoru>
npm install
cp .env.example .env
```

---

## 1) Google Cloud — Service Account

### 1.1 Proje
1. [Google Cloud Console](https://console.cloud.google.com/) açın  
2. Yeni proje oluşturun (veya mevcut seçin)

### 1.2 API’leri açın
**APIs & Services → Library** içinde şunları **Enable** edin:

- Google Sheets API  
- Google Drive API  

### 1.3 Service account
1. **IAM & Admin → Service Accounts → Create Service Account**  
2. İsim verin → Create  
3. Rol gerekmez (paylaşım Sheet/Drive üzerinden yapılır) → Done  
4. Oluşan hesabı açın → **Keys → Add Key → Create new key → JSON**  
5. İnen dosyayı projeye koyun:

```text
secrets/service-account.json
```

JSON içindeki `client_email` değerini not edin. Örnek:

```text
erd-app@sizin-proje.iam.gserviceaccount.com
```

> Bu e-posta, Sheet ve Drive klasörlerine paylaşım yapacağınız adrestir.

### 1.4 Güvenlik
- JSON’u Git’e **commit etmeyin** (`secrets/` zaten ignore edilir)  
- Başkasına repo verirken kendi JSON’unuzu silin / paylaşmayın  

---

## 2) Google Sheet — Veritabanı

### 2.1 Spreadsheet oluşturun
Google Sheets’te boş bir dosya açın. URL’deki ID’yi kopyalayın:

```text
https://docs.google.com/spreadsheets/d/XXXXXXXXXXXXXXXXXXXXXXXX/edit
                                 ↑ bu kısım = GOOGLE_SHEET_ID
```

### 2.2 Sayfa (sekme) adları
Aşağıdaki **tam isimlerle** 5 sekme oluşturun:

| Sekme adı |
|-----------|
| `Kullanicilar` |
| `Ekipler` |
| `EkipUyeleri` |
| `Klasorler` |
| `Yetkiler` |

### 2.3 Başlık satırları ve örnek veri

#### Kullanicilar
1. satır (başlık):

| username | password_hash | is_super_admin | aktif |
|----------|---------------|----------------|-------|

Örnek satır:

| admin | `$2a$12$...` | TRUE | TRUE |

Şifre hash üretin (projede):

```bash
npm run hash-password -- "SifrenizBuraya"
```

Çıktıyı `password_hash` hücresine yapıştırın. **Düz metin şifre yazmayın.**

- `is_super_admin`: `TRUE` / `FALSE`  
- `aktif`: `TRUE` / `FALSE` (pasif kullanıcı giriş yapamaz)

#### Ekipler

| team_id | team_name |
|---------|-----------|
| crm | CRM |

#### EkipUyeleri

| team_id | username |
|---------|----------|
| crm | ayse |

#### Klasorler

| folder_id | label | drive_folder_id |
|-----------|-------|-----------------|
| sales | Satış Diyagramları | 1abcDriveFolderIdBuraya |

`drive_folder_id`: Drive klasör URL’sindeki ID:

```text
https://drive.google.com/drive/folders/1abcXXXXXXXXXXXX
                                       ↑ bu kısım
```

> İlk kurulumda bu sekmeyi boş bırakıp uygulamadaki **Yönetim** ekranından da klasör bağlayabilirsiniz (super admin).

#### Yetkiler

| folder_id | grantee_type | grantee_id |
|-----------|--------------|------------|
| sales | user | ayse |
| sales | team | crm |

- `grantee_type`: `user` veya `team`  
- Super admin tüm klasörleri görür; ayrıca yetki satırı gerekmez  

### 2.4 Sheet paylaşımı
Sheet’te **Paylaş** → service account `client_email` → rol: **Düzenleyici** (Editor).

Viewer yetmez; yönetim ekranı Sheet’e yazar.

---

## 3) Google Drive — DBML klasörleri

1. Drive’da klasör(ler) oluşturun  
2. İçine `.dbml` veya `.txt` diyagram dosyaları koyun  
3. Klasörü service account e-postasıyla paylaşın:  
   - Sadece okuma: **Görüntüleyici**  
   - Super admin’in uygulamadan **Kaydet** yapması için: **Düzenleyici**  

4. Klasörü uygulamaya bağlayın:  
   - **Yönetim → Klasörler** (önerilen), veya  
   - Sheet `Klasorler` + `Yetkiler` satırları  

Opsiyonel: Admin’de listelenen klasörleri daraltmak için kök klasör ID’si:

```env
GOOGLE_DRIVE_ROOT_FOLDER_ID=1xyz...
```

---

## 4) `.env` dosyası (yerel geliştirme)

`.env.example` → `.env` kopyalayıp doldurun:

```env
API_PORT=3001
SESSION_SECRET=buraya-uzun-rastgele-bir-metin-yazin
SESSION_TTL_DAYS=7

GOOGLE_SHEET_ID=XXXXXXXXXXXXXXXXXXXXXXXX

# Yerel için dosya yolu (önerilen)
GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/service-account.json
```

`SESSION_SECRET` örneği üretmek:

```bash
openssl rand -hex 32
```

Dosya yerine doğrudan env de kullanılabilir:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=erd-app@sizin-proje.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`PRIVATE_KEY` içindeki gerçek satır sonları tek satırda `\n` olarak yazılmalıdır.

---

## 5) Yerelde çalıştırma

```bash
npm run dev
```

- Arayüz: http://127.0.0.1:5173  
- API: http://127.0.0.1:3001  

Kontrol:

```bash
curl http://127.0.0.1:3001/api/health
# {"ok":true}
```

Sheet’teki `admin` (veya oluşturduğunuz kullanıcı) ile giriş yapın.

---

## 6) Production (Vercel + Railway) — nereye tıklanır?

İki **ayrı yeni proje** kullanın:

| Parça | Platform | Ne çalışır |
|-------|----------|------------|
| API (login, Sheet, Drive) | **Railway** | `npm run start:api` |
| Arayüz (React) | **Vercel** | `npm run build` → `dist` |

Mevcut bir Vercel/Railway projesinin üzerine yazmayın; canlı eski site bozulmasın.

Önce branch’i GitHub’a push edin (ör. `v1.1`). Sonra **önce Railway (API)**, sonra **Vercel (frontend)**.

---

### 6.1 Railway — API (tıklama adımları)

1. [railway.app](https://railway.app) → giriş (GitHub ile)  
2. **New Project**  
3. **Deploy from GitHub repo** (gerekirse GitHub’ı yetkilendirin)  
4. Repo listesinden bu projeyi seçin  
5. Branch: mümkünse **`v1.1`** (veya sizin production branch’iniz)  
   - Oluşturma ekranında `main` sabit görünüyorsa devam edin; sonra değiştirirsiniz  
6. Proje / servis açılınca üst menüden **Settings**  
7. **Source** (veya Git) bölümünde **Branch** → `v1.1` yapın → kaydedin  

#### Build / Start
8. Aynı **Settings** içinde **Build** / **Deploy** ayarları:  
   - **Build Command:** `npm install` (veya boş / `railway.toml` varsa onu kullanır)  
   - **Start Command:** `npm run start:api`  
9. Repoda `railway.toml` varsa genelde bunlar otomatik gelir.

#### Environment Variables
10. Üst menüden **Variables** tıklayın  
11. **+ New Variable** / Raw Editor ile şunları ekleyin:

| Key | Value |
|-----|--------|
| `SESSION_SECRET` | uzun rastgele metin |
| `GOOGLE_SHEET_ID` | Sheet URL’deki ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | JSON’daki `client_email` |
| `GOOGLE_PRIVATE_KEY` | JSON’daki `private_key` (satır sonları `\n`) |
| `PORT` | `3001` |

12. **Kaydet** — redeploy tetiklenir  

> **Yanlış:** `GOOGLE_SERVICE_ACCOUNT_FILE` alanına email veya dosya yolu yazmak.  
> Production’da bu değişkeni **eklemeyin / silin**. Sadece EMAIL + PRIVATE_KEY kullanın.

`GOOGLE_PRIVATE_KEY` örneği (tek satır):

```text
-----BEGIN PRIVATE KEY-----\nMIIE....\n-----END PRIVATE KEY-----\n
```

#### Public URL (domain)
13. Servis → **Settings**  
14. **Networking** → **Public Networking**  
15. **Generate Domain** tıklayın  
16. Port sorarsa: **`3001`** yazın  
17. Çıkan adresi kopyalayın, örnek:

```text
https://veri-tabani-xxxx.up.railway.app
```

18. Tarayıcıda test:

```text
https://veri-tabani-xxxx.up.railway.app/api/health
```

Beklenen cevap: `{"ok":true}`

> Kök adres (`...up.railway.app/`) 404 verebilir — normal. API sadece `/api/...` yollarını sunar.

19. **Deployments** sekmesinde durum **Success** / Running olmalı. Crash varsa log’da env hatası arayın.

---

### 6.2 Vercel — Frontend (tıklama adımları)

1. [vercel.com](https://vercel.com) → giriş  
2. **Add New… → Project** (veya **Import Project**)  
3. GitHub reposunu seçin  
4. Branch seçimi:  
   - Bir önceki listede repo satırının sağındaki **branch dropdown**’dan `v1.1` seçin  
   - Configure ekranında `main` yazılı görünüyorsa çoğu zaman sabittir; deploy sonrası **Settings → Git → Production Branch** ile `v1.1` yapın  
5. Proje adı verin (ör. `erd`)  
6. **Framework Preset:** Vite (otomatik gelmeli)  
7. **Root Directory:** `./`  
8. **Build and Output Settings** (gerekirse açın):  
   - Build Command: `npm run build`  
   - Output Directory: `dist`  

#### Environment Variable (önemli)
9. Aynı Import ekranında **Environment Variables**’ı açın **veya** deploy sonrası:  
   proje → **Settings** → sol menü **Environment Variables**  
10. **Add** / **Create**:

| Key | Value | Environments |
|-----|--------|----------------|
| `VITE_API_BASE` | `https://veri-tabani-xxxx.up.railway.app` | Production (+ Preview) |

Kurallar:
- Sonda `/` olmasın  
- `/api` eklemeyin  
- `http` değil `https`  
- Custom Environment / Shared Env gibi Pro isteyen seçeneklere girmeyin; sadece **Production** / **Preview** işaretleyin  

11. **Save**  
12. İlk import’taysanız **Deploy**’a basın  

#### Env sonradan eklendiyse Redeploy
`VITE_*` değerleri **build anında** gömülür. Env’yi deploy’dan sonra eklediyseniz:

13. Üst menü **Deployments**  
14. En son deployment satırında **⋯** (üç nokta)  
15. **Redeploy**  
16. Mümkünse “Use existing Build Cache” **kapalı** / Clear cache ile redeploy  

#### Sonuç
17. Vercel size bir URL verir: `https://erd-xxxx.vercel.app`  
18. Bu adresi açın → login ekranı gelmeli  
19. Tarayıcı **Developer Tools → Network**: login isteği Railway domain’ine gitmeli  

---

### 6.3 İkisini bağlama özeti

```text
Tarayıcı
   │
   ▼
Vercel (erd-xxxx.vercel.app)     ← VITE_API_BASE burada tanımlı
   │  fetch
   ▼
Railway (...up.railway.app/api/...)  ← Sheet + Drive burada
```

Sıra: **1) Railway ayakta + `/api/health` OK → 2) Vercel’e `VITE_API_BASE` → 3) Redeploy**.

---

## 7) İlk girişten sonra (super admin)

1. Sol panel → **Yönetim**  
2. Kullanıcı / ekip / klasör / yetki tanımlayın  
3. ERD’ye dönün → Drive dosyaları listelenir  
4. Super admin Drive dosyasında **Kaydet** ile güncelleyebilir (klasör Editor paylaşılmış olmalı)

---

## 8) Sık hatalar

| Belirti | Muhtemel neden | Ne yapın |
|---------|----------------|----------|
| API crash / dosya bulunamadı | `GOOGLE_SERVICE_ACCOUNT_FILE` production’da | EMAIL + PRIVATE_KEY kullanın; FILE’ı silin |
| Giriş başarısız | Hash yanlış / kullanıcı pasif | `hash-password` ile yeniden üretin; `aktif=TRUE` |
| Sheet okunamıyor / yazılamıyor | Paylaşım yok veya Viewer | Service account’a **Düzenleyici** |
| Drive dosyaları boş | Klasör paylaşılmamış / yetki yok | Klasörü SA ile paylaşın; `Klasorler`+`Yetkiler` veya Yönetim |
| Kaydet hata | Drive Writer yok | Klasöre **Düzenleyici** verin |
| Vercel login API’ye gitmiyor | `VITE_API_BASE` yok / redeploy yok | Env ekle + cache’siz Redeploy |
| Railway `/` 404 | Normal | Sadece `/api/...` endpoints vardır |
| Dil / UI çalışıyor ama veri yok | Yanlış Sheet ID | `.env` / Variables’taki ID’yi kontrol edin |

---

## 9) Başka ekibe / kişiye verirken checklist

Onlara şunu verin:

- [ ] Bu `docs` / kurulum rehberi  
- [ ] Repo erişimi (secrets **olmadan**)  
- [ ] “Kendi GCP + Sheet + Drive + `.env`” notu  

Onların yapması gerekenler:

- [ ] Kendi service account JSON  
- [ ] Kendi Sheet (5 sekme + admin kullanıcı)  
- [ ] Kendi Drive klasör paylaşımları  
- [ ] Kendi `.env` / Railway Variables  
- [ ] Kendi deploy (ayrı Vercel/Railway veya VPS)  

**Vermeyin:** sizin `secrets/*.json`, `.env`, production private key’leri.

---

## 10) Kısa özet

| Ne | Nerede |
|----|--------|
| Google kimlik | GCP → service account JSON |
| Kullanıcı / yetki DB | Google Sheet (5 sekme) |
| Diyagram dosyaları | Drive klasörleri + paylaşım |
| Bağlantı ayarı | `.env` veya sunucu Variables |
| Arayüz | Değiştirmeye gerek yok |

Sorun olursa önce `/api/health`, sonra login Network isteği ve Google paylaşım rollerini kontrol edin.
