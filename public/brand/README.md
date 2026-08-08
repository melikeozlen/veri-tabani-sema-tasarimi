# Firma logoları — ER Diyagramı

## Drive’a nereye koyulur?

Diyagram klasörlerini (kullanıcı yetkisi) ayrı tutup logoları ortak bir yerde tutabilirsiniz:

```text
ER/
  CETAS ER/          ← yetkili diyagram klasörü
  ER Diyagramları/   ← yetkili diyagram klasörü
  LOGO/
    logo-light.png
    logo-dark.png
```

Uygulama şuraları arar (sırayla):

1. Yetkili diyagram klasörünün kökü  
2. O klasörün içindeki `LOGO` / `logo` / `Brand` alt klasörü  
3. Üst klasörün kökü (`ER/`)  
4. Üst klasördeki `LOGO` kardeş klasörü ← sizin yapı

| Tema | Dosya adı |
|------|-----------|
| Açık | `logo-light.png` (veya `.svg` / `.webp`) |
| Koyu | `logo-dark.png` (veya `.svg` / `.webp`) |

**Önemli:** `LOGO` klasörünü de service account e-postasıyla paylaşın (en az Görüntüleyici) — yalnızca diyagram klasörü paylaşılıysa logo görünmez.

Sayfa yenilendiğinde önceki logo cache’ten gelir; Drive’dan yenisi gelince güncellenir.

## Yerel yedek (opsiyonel)

Drive’da logo yoksa `public/brand/` kullanılır. İkisi de yoksa sol üstte **ER Diyagramı** yazısı görünür.
