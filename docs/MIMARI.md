# Sunucu Mimarisi (Aşama 1)

## 1. Veritabanı (`schema.sql`, `db.js`)
| Tablo | İçerik |
|---|---|
| `accounts` | kullanıcı adı, scrypt şifre özeti + tuz, durum (0 aktif / 1 engelli / 2 dondurulmuş), krallık, tarihler |
| `sessions` | otomatik giriş anahtarları (hesap başına en fazla 5 cihaz) |
| `characters` | hesap, isim, sınıf (savasci, golge, buyucu, saman), krallık, seviye, tecrübe, ahlak derecesi, harita, X/Y/Z, STR/DEX/INT/VIT, statü puanı, altın, öldürme/ölüm, oynama süresi |
| `inventory` | karakter, kap (çanta/ekipman/depo/pazar), slot, eşya şablonu, miktar, +basma (0-9), 7 efsun yuvası (1-5 temel, 6-7 özel), pazar fiyatı |
| `skills` | karakter, beceri, seviye (1-20), kademe (0 Temel, 1 Usta, 2 Büyük Usta, 3 Kusursuz) |
| `security_log` | hile şüpheleri ve hatalı girişler (admin paneli için) |

- Envanter ve beceri kayıtları tek işlemde (transaction) yazılır. Bir satır hatalıysa hiçbiri yazılmaz.
- `DATABASE_URL` yoksa aynı işlemler `data/db.json` dosyasında yapılır (sadece geliştirme için).
- Eski sürümün anahtar-değer (`kv`) kayıtları ilk açılışta yeni tablolara otomatik taşınır.

## 2. Görüş Alanı / AoI (`aoi.js`)
- Harita 256×256 piksellik hücrelere bölünür. Oyuncular ve kuklalar (ileride canavarlar ve yerdeki eşyalar) bulundukları hücreye kaydedilir.
- Her ağ paketinde oyuncuya sadece 1100 px (~55 m) yarıçaptaki varlıklar, mermiler ve konumlu olaylar (hasar yazısı, patlama vb.) gönderilir. Sohbet, öldürme bildirimi ve sıralama gibi genel olaylar herkese gider.
- Hasar hesapları da aynı ızgarayı kullanır: "bu kılıç darbesinin menzilinde kim var?" sorusu için bütün dünya değil, sadece yakın hücreler taranır.
- Simülasyon saniyede 30 adım çalışır, ağ paketi saniyede 15 kez gönderilir.
- Görünmez düşmanların konumu istemciye hiç gönderilmez. İstemcide gizlemek yetmez, çünkü hileli bir istemci gizlenen veriyi görebilir.

## 3. Hile Koruması (`anticheat.js`)
- **İstemci hiçbir sonuca karar vermez.** Sadece "hangi tuş basılı, nereye bakıyorum" bilgisini gönderir. Konumu, hızı, saldırı hızını, hasarı ve bekleme sürelerini sunucu kendi saatiyle hesaplar. Sahte konum, hız veya hasar göndermek etkisizdir.
- **ActionGate:** Her eylemin (saldırı, beceri, ileride iksir ve eşya kullanımı) bir sonraki kullanım zamanı sunucu saatine göre tutulur.
- **Hareket denetçisi:** Her adımda gidilen yol, `hız × süre × 1.15` ile karşılaştırılır. Aşarsa oyuncu son geçerli konumuna çekilir ve ihlal kaydedilir.
- **Paket sınırlayıcı (token bucket):** Her mesaj türünün saniyelik bir sınırı vardır.
- **İhlal puanı:** Hız sınırı aşma, bozuk paket gibi davranışlar puan biriktirir. Puan zamanla azalır, 60'ı geçerse oyuncu atılır ve `security_log` tablosuna kayıt düşülür.
- **Giriş güvenliği:** scrypt ile şifre özeti, sabit süreli karşılaştırma, 5 hatalı denemede 30 saniye bekleme, engelli hesap kontrolü.
