# CRM DBML ERD Viewer

DBML metnini React Flow üzerinde otomatik ELK yerleşimiyle salt-okunur ER diyagramı olarak gösterir.

## Çalıştırma

```bash
npm install
npm run dev
```

`src/` altındaki `.dbml` dosyaları sol menüde listelenir. Yeni dosya ekleyebilir veya soldan yükleyebilirsiniz.

Sağ menüden şema/tablo/kolon arayabilir, şema başına tablo sayılarını görebilirsiniz.
Çizgi veya tablo üzerine gelince bağlantılar vurgulanır; tablo notları başlıktaki ikonla okunur.

## Desteklenen DBML yapıları

- `Table`
- `Enum` tanımları (alan tipi üzerine gelince değerler gösterilir)
- Alan tipleri ve `[pk, not null, unique, increment, default, note]`
- Tablo `Note`
- Dışarıda tanımlanan `Ref:` ilişkileri
- Kolon içinde `[ref: > table.field]` ilişkileri
- `>`, `<`, `-`, `<>` kardinaliteleri

Bileşik foreign key ifadeleri bu hafif tarayıcı parser'ında uyarı üreterek atlanır.
