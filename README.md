# PvP Server

Tarayıcıda, telefonda ve bilgisayarda oynanan çok oyunculu PvP oyunu.

## Bilgisayarında çalıştırma
```
npm install
npm start
```
Sonra tarayıcıda http://localhost:3000 adresini aç.

## Kontroller
- **PC:** WASD hareket, fare nişan, sol tık veya Boşluk saldırı, Q ve E beceriler, Enter sohbet
- **Telefon:** solda joystick, sağda SALDIR / Q / E tuşları (en yakın düşmana otomatik nişan)

## Sınıflar
| Sınıf | Q | E |
|---|---|---|
| Savaşçı | Hamle | Demir Kalkan |
| Gölge Avcı | Zehirli Hançer | Gölge Örtüsü (görünmezlik) |
| Ruh Büyücüsü | Alev Küresi | Şifa Işığı |

## Dosyalar
- `server.js`: oyun sunucusu (bütün hesaplar burada yapılır, hile koruması)
- `public/client.js`: oyun ekranı
- `public/config.js`: telefon/PC sürümleri için sunucu adresi
