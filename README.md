# PvP Server

Tarayıcıda, telefonda ve bilgisayarda oynanan çok oyunculu PvP oyunu.

## Özellikler
- Hesap sistemi (kayıt / giriş, otomatik giriş), hesap başına 3 karakter
- 3 krallık: Kızıl Ejder, Gök Kaplan, Yeşim Turna. Her birinin kendi köyü var, aynı krallıktakiler birbirine vuramaz
- 4 sınıf (her biri 4 beceri): Savaşçı, Gölge Avcı, Ruh Kılıcı, Şaman
- Seviye sistemi (30'a kadar), sıralama tablosu, sohbet, mini harita
- Telefon için dokunmatik kontroller

## Bilgisayarında çalıştırma
```
npm install
npm start
```
Sonra http://localhost:3000 adresini aç. Kayıtlar `data/db.json` dosyasına yazılır.

## İnternette (Render) kalıcı kayıt
Render'ın ücretsiz planında dosyalar her yeniden başlatmada silinir. Kalıcı kayıt için
bir PostgreSQL veritabanı (örneğin Neon, ücretsiz) aç ve bağlantı adresini Render'da
`DATABASE_URL` ortam değişkenine yaz. Sunucu tabloyu kendisi oluşturur.

## Kontroller
- **PC:** WASD hareket, fare nişan, sol tık / Boşluk saldırı, Q ve E beceriler, Enter sohbet
- **Telefon:** solda joystick, sağda SALDIR / Q / E (en yakın düşmana otomatik nişan)

## Dosyalar
- `server.js`: oyun sunucusu ve hesap sistemi
- `db.js`, `schema.sql`: veritabanı (PostgreSQL veya dosya)
- `aoi.js`: görüş alanı ızgarası
- `anticheat.js`: hile koruması
- `docs/MIMARI.md`: mimari açıklaması
- `public/`: oyun ekranı
