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

# Aşama 2: Sınıflar ve Yetenek Sistemi

## Yetenek sistemi (`server.js`, Unreal GAS mantığının karşılığı)
- **Beceri tanımı:** ad, mana maliyeti, bekleme süresi, açıklama ve sunucuda çalışan `cast()`. Her sınıfta Q/E/R/F tuşlarında 4 beceri var.
- **Etkiler (buff/debuff):** `{ id, until, mods }` biçiminde. `mods` alanları: `atk` (saldırı gücü), `taken` (alınan hasar), `crit` (kritik şansı), `speed` (hız), `lifesteal` (can çalma). Aynı etki üst üste binmez, süresi yenilenir.
- **Durumlar:** sersemleme (`stunUntil`: hareket, saldırı ve beceri kullanılamaz), görünmezlik (`iv` etkisi, saldırınca bozulur), zehir.
- **Zamanlanmış adımlar (`timers`):** kombo becerilerinin vuruşları sırayla, sunucu saatiyle çalışır. Unreal'daki AnimMontage bildirimlerinin karşılığı.
- **Hasar akışı:** saldırı gücü → pusu bonusu → kritik (×1.6) → hedefin hasar azaltması → can çalma → geri savurma → sersemletme.

## Vuruş tespiti (hedef seçmeden)
- `hitCone(p, menzil, açı)`: karakterin baktığı yöndeki koni. Normal saldırılar, Kara Dalga ve Sinsi Darbe bunu kullanır.
- `hitCircle(x, y, yarıçap)`: 360° alan. Kılıç Kasırgası ve Alev Küresi patlaması bunu kullanır.
- `isBehind(saldıran, hedef)`: hedefin baktığı yöne göre 110°'den geniş açı varsa saldıran arkada sayılır (Sinsi Darbe ×2.5).
- Hepsi AoI ızgarasından sadece yakındaki hedefleri çeker.

## Geri savurma ve sersemletme
- Savurma, vuran kişiden hedefe doğru bir hız olarak uygulanır ve her adımda %18 sönümlenir. Kayaya çarpınca durur (çarpışma çözümü).
- Oyunculara savurmanın %50'si, sersemletmenin %70'i uygulanır (PvP dengesi). Canavarlara (Aşama 3) tam uygulanacak.
- Hareket denetçisi savurma hızını izin verilen hıza ekler, yani savrulan oyuncu hile şüphesiyle işaretlenmez.

## Sınıflar
| Sınıf | Q | E | R | F |
|---|---|---|---|---|
| Savaşçı | Kılıç Kasırgası (360°, 3 vuruş) | Öfke Aurası (+%30 saldırı) | Hamle (sersemletir) | Demir Kalkan (-%50 hasar) |
| Gölge Avcı | Zehirli Hançer | Gölge Örtüsü (görünmezlik, ilk vuruş ×1.5) | Sinsi Darbe (arkadan ×2.5) | Geri Sıçrama |
| Ruh Kılıcı | Ruh Kılıcı (%12 can çalma) | Alev Küresi | Kara Dalga (koni, savurma) | Şifa Işığı |
| Şaman | Şimşek (sersemletir) | Turna Kutsaması (dostlara +%25 kritik) | Şifa Yağmuru | Rüzgâr Adımı (+%30 hız) |

Şamanın alan güçlendirmeleri şimdilik yakındaki aynı krallık oyuncularına uygulanıyor. Parti sistemi gelince partiye bağlanacak.

# Aşama 3: Canavar Yapay Zekası

## Davranış tipleri ve durum makinesi
- **Pasif** (Kızıl Tilki): asla saldırmaz, vurulunca 2.5 sn kaçar.
- **Yarı agresif** (Boz Kurt, Yaban Domuzu): vurulana kadar dolaşır, vurulunca saldırır.
- **Tam agresif** (Dağ Haydudu, Kara Ayı): görüş menziline (200-230 px) giren oyuncuya saldırır. Görünmez oyuncuları fark etmez.
- Durumlar: `idle` (doğma noktası çevresinde dolaşma) → `chase` (kovalama) → saldırı hazırlığı (0.35 sn, kırmızı halka; oyuncu kaçabilir) → vuruş → `return` (dönüş).

## Tehdit (aggro) tablosu
- Her canavar `oyuncu → tehdit` tablosu tutar. Verilen hasar tehdit ekler, iyileştirme yapan oyuncu da tehdidin yarısını alır.
- En yüksek tehdide sahip geçerli oyuncu hedeflenir. Geçersiz hedefler (çıkmış, ölmüş, köye girmiş, çok uzaklaşmış, görünmez ve uzak) tablodan silinir.

## Grup uyarısı (Pack Alert)
- Canavarlar gruplar halinde doğar. Gruptan birine vurulunca, 450 px içindeki boştaki grup üyeleri saldırana yönelir. Ekranda "!" işareti çıkar.
- Agresif bir canavar oyuncuyu fark edince de grubunu uyarır.

## Çarpışma
- Canavarlar kendi aralarında yumuşak ayrışma uygular (çakışmanın %25'i kadar itişme). İç içe geçmezler, oyuncunun etrafında halka oluştururlar.
- Oyuncuya değen canavar kendisi kenara çekilir. Oyuncu hiçbir zaman itilmez ya da kilitlenmez.
- Canavarlar kayalara ve köylere giremez (köyler güvenli bölge).

## Duvara sıkıştırma (`applyKnockback`)
- Savrulan canavar bir engele çarptığında çarpışma normali `n` hesaplanır. Hızın duvara giren bileşeni silinir: `v' = v − (v·n)·n`. Canavar duvar boyunca kayar.
- Kalan hız ilk hızın %35'inden azsa (dik çarpma ya da köşe) canavar **sıkışmış** sayılır ve 0.6 sn sersemler. Ekranda "SIKIŞTI!" yazar.

## Geri dönüş (Leash)
- Doğma noktasından 800 px'ten (40 m) fazla uzaklaşan ya da hedefini kaybeden canavar savaşı bırakır.
- Tehdit tablosu silinir, 1.6× hızla yerine koşar, yolda canı dolar. Dönerken hasar almaz.

## Performans
- Yakınında (1400 px) oyuncu olmayan ve boşta duran canavarlar uyutulur. Bu kontrol yarım saniyede bir yapılır.
- Canavarlar AoI ızgarasında tutulur: oyuncuya sadece görüş alanındakiler gönderilir.

## Canavarlar
| Tür | Seviye | Tip | Tecrübe |
|---|---|---|---|
| Kızıl Tilki | 1 | pasif | 18 |
| Boz Kurt | 3 | yarı agresif | 40 |
| Yaban Domuzu | 5 | yarı agresif | 70 |
| Dağ Haydudu | 8 | agresif | 120 |
| Kara Ayı | 12 | agresif | 320 |

Oyuncunun seviyesi canavardan 5'ten fazla yüksekse tecrübe yarıya, 10'dan fazla yüksekse onda bire düşer.

# Aşama 4: Eşya, Yükseltme ve Efsun (`items.js`)

## Eşyalar
- Sınıf silahları (Demir Kılıç, Çelik Hançer, Ruh Palası, Ardıç Asası), Deri Zırh, Demir Miğfer.
- Silah saldırı gücünü (hasara %), zırh ve miğfer savunmayı (alınan hasardan %) ve canı artırır. Her + seviye temel değeri çarpar: +0 ×1 … +9 ×2.7.
- Malzemeler: Kara Demir Parçası, Ay Taşı, Kadim Pul. Parşömenler: Kutsama Parşömeni, Büyülü Metal. Efsun eşyaları: Efsun Taşı, Değişim Tozu.
- Yeni karakter başlangıç eşyalarıyla ve 5000 altınla başlar.
- **Geçici:** Canavarlar altın ve malzemeyi doğrudan çantaya verir. Aşama 5'te yere düşen ganimete dönüşecek.

## Yükseltme (köydeki demircide)
| Seviye | Şans | Altın | Malzeme |
|---|---|---|---|
| +0→+1 | %100 | 500 | – |
| +1→+2 | %95 | 1.000 | – |
| +2→+3 | %90 | 2.000 | – |
| +3→+4 | %80 | 4.000 | – |
| +4→+5 | %70 | 7.000 | Kara Demir ×1 |
| +5→+6 | %50 | 10.000 | Kara Demir ×2 |
| +6→+7 | %40 | 15.000 | Ay Taşı ×1 |
| +7→+8 | %25 | 22.000 | Ay Taşı ×2 |
| +8→+9 | %15 | 30.000 | Kadim Pul ×1 |

- Başarısızlıkta: standart demircide eşya **yanar**, Kutsama Parşömeni ile **1 seviye düşer**, Büyülü Metal ile **aynı kalır**.
- Ücret ve malzeme her durumda ödenir. Rastgelelik sunucuda `crypto.randomInt` ile üretilir.
- Sunucu, oyuncunun demirciye 170 px'ten yakın olduğunu kontrol eder. Sonuç anında veritabanına yazılır.
- 100.000 denemelik testte her seviyenin ölçülen başarı oranı tablodakiyle ±%0.5 içinde.

## Efsun
- 15 efsun: Maks. Can, Maks. Mana, Kritik, Delici Vuruş, Saldırı Hızı, Hareket Hızı, Canavarlara Karşı Güç, Oyunculara Karşı Güç, Kılıç Savunması, Büyü Savunması, Can Emme, Mana Emme, Sersemletme, Güç, Çeviklik.
- Her efsunun 5 kademesi var (yüzdelikler için %2 / %4 / %6 / %10 / %15). Kademe ağırlıklı rastgele seçilir: 40 / 30 / 18 / 9 / 3.
- Silah, zırh ve miğferin kendine özgü efsun havuzu var.
- **Efsun Taşı:** boş yuvaya, eşyada olmayan bir efsun ekler. Başarı şansı 1. efsunda %100'den 5. efsunda %25'e düşer. 1-5 temel yuvalardır, 6-7 özel efsunlar için ayrıldı.
- **Değişim Tozu:** efsun sayısı aynı kalır, hepsi kısmi Fisher-Yates karıştırmayla **tekrarsız** yeniden çekilir.
- Bütün efsunlar savaşa gerçekten etki eder (hasar, savunma türü, saldırı ve hareket hızı, can ve mana emme, sersemletme, delici vuruş).

# Aşama 5: Bozulma Taşları ve Ganimet

## Bozulma Taşı
- Hareketsiz, çok canlı (Sv.5: 3.000, Sv.10: 6.500, Sv.15: 11.000) ve zırhlı (%30-40 hasar azaltma, delici vuruş zırhı yok sayar). Geri savrulmaz, sersemlemez.
- Canı **%80 / %60 / %40 / %20** eşiklerine düştükçe etrafına (taş yarıçapı + 110-220 px) **3-4 grup** agresif canavar çağırır. Çağrılanlar o ana kadar en çok hasar veren oyuncuya saldırır.
- Çağrılan canavarlar yeniden doğmaz. Boşta kalırlarsa 150 sn sonra kaybolurlar.
- Haritada 9 olası yer var, aynı anda 5 taş bulunur. Kırılan taş 90-150 sn sonra boş bir yerde yeniden belirir.
- Yakında oyuncu yoksa hasarlı taş yavaşça iyileşir. Tam cana dönünce eşikler sıfırlanır.
- **Görsel efekt:** İstemci `şiddet = 1 − can/maksCan` değerini hesaplar. Parıltının yarıçapı, opaklığı ve nabız hızı, çatlak sayısı ve kıvılcım sıklığı bu değerle artar (Unreal'daki malzeme parametresinin karşılığı).
- Tecrübe, taşa hasar veren herkese hasar payına göre dağıtılır.

## Ganimet tabloları (`loot.js`)
- `LootTable`: altın aralığı (birden çok yığına bölünebilir), bağımsız şanslı eşya satırları, en az eşya garantisi. Eşyalar + seviyeli de düşebilir (taş seviyesine göre +0..+4).
- Canavarlar ve taşlar için ayrı tablolar var. Taşlar Beceri Kitabı, malzeme, parşömen, efsun eşyası, zırh ve silah düşürür.

## Yere saçılma
- Eşyalar kaynağın etrafına eşit aralıklı açılarla, rastgele hızla fırlar. Her adımda %14 sürtünmeyle yavaşlar, kayalardan seker.
- Ganimet ayrı bir AoI ızgarasında tutulur, yalnızca görüş alanındaki oyunculara gönderilir.

## Sahiplik (çalınmaya karşı)
- Ganimetin sahibi, kaynağa en çok hasar veren oyuncudur (karakter kimliğiyle tutulur, oyuncu çıkıp girse de sahiplik kalır).
- İlk **30 saniye** yalnızca sahibi toplayabilir. Diğer oyuncular eşyanın altında sahibinin adını ve kalan süreyi görür. Toplamaya çalışırlarsa sunucu reddeder.
- 30 saniye sonra herkes toplayabilir. 120 saniye sonra eşya yok olur.
- Parti sistemi gelince sahiplik partiye genişletilecek.
- Toplama: **Z** tuşu, telefonda 🖐 düğmesi (90 px içindeki toplanabilir her şey).

## Beceri seviyeleri
- **Beceri Kitabı** okununca seçilen becerinin seviyesi 1 artar (1-20). Her seviye becerinin hasarını ve iyileştirmesini %4 artırır.
- Seviyeler `skills` tablosuna kaydedilir. Beceri çubuğunda seviye görünür (örn. "Q 2").

# Aşama 6: Izgara Envanter ve Oyuncu Pazarı

## Izgara envanter (`items.js`, `public/items-ui.js`)
- Çanta **6 × 8** hücre. Eşyanın `slot` değeri sol üst hücresidir (`satır × 6 + sütun`).
- Boyutlar: Çelik Hançer 1×1, Demir Kılıç ve Ruh Palası 1×2, Ardıç Asası 1×3, Deri Zırh 2×2, miğfer ve malzemeler 1×1.
- `occupancy()` her hücrenin hangi eşyaya ait olduğunu gösteren matrisi çıkarır. `canPlace()` taşma ve çakışmayı kontrol eder. `freeSlot()` eşyanın sığdığı ilk yeri satır satır arar.
- Sürükle-bırak (fare ve dokunmatik, Pointer Events):
  - çanta → çanta: taşıma; aynı tür yığılabilir eşyanın üstüne bırakınca yığma
  - çanta → ekipman yuvası: kuşanma (eski eşya, yenisinin boşalttığı yere ya da ilk boş yere gider)
  - ekipman → çanta: istenen hücreye çıkarma
  - panel dışına: yere atma (30 sn sadece sahibi alabilir)
- İstemci bırakılacak yeri yeşil/kırmızı gösterir (aynı algoritmanın kopyası). Son kararı sunucu verir.
- Eski kayıtlarda çakışan eşyalar girişte `normalize()` ile boş yerlere taşınır.

## Oyuncu pazarı (`server.js` PAZAR bölümü, `public/shop-ui.js`)
- Sadece köyde (güvenli bölge) kurulur. En fazla 8 eşya, eşya başına birim fiyat (1 - 2 milyar altın).
- Eşyalar `inventory.container = 3` (pazar tezgahı) kabına, `price` sütunuyla taşınır. Çantadan çıktıkları için kullanılamaz, yükseltilemez, yere atılamaz.
- Pazar açıkken satıcı hareket edemez, saldıramaz, beceri kullanamaz. Başının üstünde tabela görünür.
- Alıcı tabelaya tıklar, sunucu güncel listeyi gönderir. Liste her satıştan sonra satıcıya ve listeye bakan herkese yeniden gönderilir.
- Yığın eşyalarda miktar seçilebilir (kısmi alım). Satıcı çıkarsa pazar kapanır, eşyalar çantaya döner. Yer yoksa pazar kabında kalır ve sonraki girişte döner.

## Satın almada yarış durumunun (race condition) önlenmesi
1. **Tek adımda kontrol + aktarma:** Node.js sunucusu tek iş parçacıklı bir olay döngüsünde çalışır. `buy()` içinde "eşya hâlâ duruyor mu, fiyat aynı mı, altın yetiyor mu, çantada yer var mı" kontrolleri ve eşya/altın aktarımı arada hiç beklemeden (`await` olmadan) yapılır. Aynı anda gelen iki istekten ilki tamamen bitmeden ikincisi başlamaz. İkinci istek eşyayı bulamaz ve "Bu eşya az önce satıldı" yanıtını alır.
2. **İyimser doğrulama:** Alıcı, ekranda gördüğü eşya kimliğini ve fiyatı isteğe ekler. Sunucudaki değer farklıysa satış reddedilir. Böylece fiyatı son anda değiştirme tuzağı işe yaramaz.
3. **Veritabanı işlemi:** İki oyuncunun envanteri ve altını `saveTrade()` ile **tek bir transaction** içinde yazılır. Karakter satırları sabit sırayla `SELECT … FOR UPDATE` ile kilitlenir (kilitlenme/deadlock olmaz). Sunucu yazma sırasında çökerse işlemin tamamı geri alınır, eşya kopyalanmaz ya da kaybolmaz.
4. Her satış `security_log` tablosuna `trade` olarak kaydedilir.
- Birden fazla oyun sunucusuna geçilirse 3. madde zaten veritabanı düzeyinde kilitleme sağlıyor. Ek olarak eşyanın `uid` sütunu ile `DELETE … WHERE uid = … RETURNING` kontrolü eklenebilir.

Test sonucu: iki alıcı aynı kılıcı aynı anda aldı, yalnızca biri başarılı oldu. Kaybeden para ödemedi, kılıç kopyalanmadı. PostgreSQL'de toplam altın korundu (3 oyuncu × 5000 = 15000).
