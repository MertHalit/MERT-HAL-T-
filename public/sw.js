// Basit servis çalışanı: uygulamanın kurulabilmesi için gerekli. Her zaman güncel dosyayı ağdan alır.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
