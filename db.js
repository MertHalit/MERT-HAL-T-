// Basit anahtar-değer veritabanı.
// DATABASE_URL tanımlıysa PostgreSQL kullanır (kalıcı, internette önerilen).
// Tanımlı değilse data/db.json dosyasına yazar (bilgisayarında denemek için).
const fs = require('fs');
const path = require('path');

let db;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  const ready = pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
  db = {
    kind: 'PostgreSQL',
    async get(k) {
      await ready;
      const r = await pool.query('SELECT v FROM kv WHERE k = $1', [k]);
      return r.rows[0] ? r.rows[0].v : null;
    },
    async set(k, v) {
      await ready;
      await pool.query(
        'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v',
        [k, JSON.stringify(v)],
      );
    },
    // Anahtar boşsa yazar ve true döner; doluysa dokunmaz ve false döner.
    async claim(k, v) {
      await ready;
      const r = await pool.query(
        'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING RETURNING k',
        [k, JSON.stringify(v)],
      );
      return r.rowCount === 1;
    },
    async del(k) {
      await ready;
      await pool.query('DELETE FROM kv WHERE k = $1', [k]);
    },
  };
} else {
  const file = path.join(__dirname, 'data', 'db.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let timer = null;
  const flush = () => {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 500); };
  process.on('exit', () => { if (timer) flush(); });
  db = {
    kind: 'dosya (data/db.json)',
    async get(k) { return k in data ? JSON.parse(JSON.stringify(data[k])) : null; },
    async set(k, v) { data[k] = JSON.parse(JSON.stringify(v)); save(); },
    async claim(k, v) { if (k in data) return false; data[k] = JSON.parse(JSON.stringify(v)); save(); return true; },
    async del(k) { delete data[k]; save(); },
  };
}

module.exports = db;
