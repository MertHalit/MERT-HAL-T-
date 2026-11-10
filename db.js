// Veritabanı katmanı.
// DATABASE_URL tanımlıysa PostgreSQL (schema.sql) kullanılır: internette kalıcı kayıt için bu gerekli.
// Tanımlı değilse aynı işlemler data/db.json dosyasında yapılır (bilgisayarında denemek için).
const fs = require('fs');
const path = require('path');

const ATTR_SLOTS = 7;
const MAX_SESSIONS = 5;

// Satır -> oyun nesnesi
function mapChar(r) {
  if (!r) return null;
  return {
    id: String(r.id), accountId: String(r.account_id), name: r.name, cls: r.class, faction: r.faction,
    level: Number(r.level), exp: Number(r.exp), alignment: Number(r.alignment), mapId: Number(r.map_id),
    x: r.pos_x == null ? null : Number(r.pos_x), y: r.pos_y == null ? null : Number(r.pos_y), z: Number(r.pos_z || 0),
    str: Number(r.stat_str), dex: Number(r.stat_dex), int: Number(r.stat_int), vit: Number(r.stat_vit),
    statPoints: Number(r.stat_points), gold: Number(r.gold), kills: Number(r.kills), deaths: Number(r.deaths),
    playSeconds: Number(r.play_seconds),
  };
}
function mapAccount(r) {
  if (!r) return null;
  return {
    id: String(r.id), username: r.username, hash: r.pass_hash, salt: r.pass_salt,
    status: Number(r.status), faction: r.faction || null,
  };
}
function mapItem(r) {
  const attrs = [];
  for (let i = 1; i <= ATTR_SLOTS; i++) attrs.push({ type: Number(r[`attr${i}_type`]), value: Number(r[`attr${i}_value`]) });
  return {
    uid: String(r.uid), container: Number(r.container), slot: Number(r.slot), itemId: Number(r.item_id),
    count: Number(r.count), plus: Number(r.plus), attrs, price: r.price == null ? null : Number(r.price),
  };
}
// Oyun nesnesi -> satır sütunları
function charColumns(c) {
  return {
    level: c.level, exp: c.exp, alignment: c.alignment, map_id: c.mapId, pos_x: c.x, pos_y: c.y, pos_z: c.z || 0,
    stat_str: c.str, stat_dex: c.dex, stat_int: c.int, stat_vit: c.vit, stat_points: c.statPoints,
    gold: c.gold, kills: c.kills, deaths: c.deaths, play_seconds: c.playSeconds,
  };
}
function itemColumns(it) {
  const row = { container: it.container ?? it.window ?? 0, slot: it.slot, item_id: it.itemId, count: it.count, plus: it.plus || 0, price: it.price ?? null };
  for (let i = 1; i <= ATTR_SLOTS; i++) {
    const a = (it.attrs || [])[i - 1] || { type: 0, value: 0 };
    row[`attr${i}_type`] = a.type; row[`attr${i}_value`] = a.value;
  }
  return row;
}

// =====================================================================
// PostgreSQL
// =====================================================================
function createPg(url) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    max: 10,
  });
  const q = (sql, params) => pool.query(sql, params);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // Eski sürümdeki (anahtar-değer) kayıtları yeni tablolara taşı.
  async function migrateKv() {
    const has = await q("SELECT to_regclass('public.kv') AS t");
    if (!has.rows[0].t) return;
    const count = await q('SELECT count(*)::int AS n FROM accounts');
    if (count.rows[0].n > 0) return;
    const accs = await q("SELECT v FROM kv WHERE k LIKE 'acc:%'");
    let moved = 0;
    for (const { v: a } of accs.rows) {
      const r = await q(
        'INSERT INTO accounts (username, pass_hash, pass_salt, faction) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
        [a.user, a.hash, a.salt, a.faction || null],
      );
      if (!r.rows[0]) continue;
      for (const cid of a.chars || []) {
        const cr = await q('SELECT v FROM kv WHERE k = $1', ['char:' + cid]);
        const c = cr.rows[0] && cr.rows[0].v;
        if (!c) continue;
        await q(
          `INSERT INTO characters (account_id, name, class, faction, level, exp, kills, deaths)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [r.rows[0].id, c.name, c.cls, c.faction, c.lvl, c.xp, c.kills, c.deaths],
        );
      }
      moved++;
    }
    if (moved) console.log(`Eski kayıtlar taşındı: ${moved} hesap`);
  }

  const ready = (async () => {
    await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    await migrateKv();
  })();
  ready.catch((e) => { console.error('Veritabanı hazırlanamadı:', e.message); process.exit(1); });

  return {
    kind: 'PostgreSQL',
    ready,

    async createAccount(username, hash, salt) {
      const r = await q(
        `INSERT INTO accounts (username, pass_hash, pass_salt) VALUES ($1,$2,$3)
         ON CONFLICT ((lower(username))) DO NOTHING RETURNING *`,
        [username, hash, salt],
      );
      return mapAccount(r.rows[0]);
    },
    async getAccountByName(username) {
      return mapAccount((await q('SELECT * FROM accounts WHERE lower(username) = lower($1)', [username])).rows[0]);
    },
    async getAccount(id) {
      return mapAccount((await q('SELECT * FROM accounts WHERE id = $1', [id])).rows[0]);
    },
    async touchLogin(id) { await q('UPDATE accounts SET last_login = now() WHERE id = $1', [id]); },
    async setFaction(id, faction) { await q('UPDATE accounts SET faction = $2 WHERE id = $1', [id, faction]); },

    async createSession(accountId, token) {
      await tx(async (c) => {
        await c.query('INSERT INTO sessions (token, account_id) VALUES ($1,$2)', [token, accountId]);
        await c.query(
          `DELETE FROM sessions WHERE account_id = $1 AND token NOT IN
           (SELECT token FROM sessions WHERE account_id = $1 ORDER BY created_at DESC LIMIT ${MAX_SESSIONS})`,
          [accountId],
        );
      });
    },
    async getSessionAccount(token) {
      const r = await q('SELECT account_id FROM sessions WHERE token = $1', [token]);
      return r.rows[0] ? String(r.rows[0].account_id) : null;
    },
    async deleteSession(token) { await q('DELETE FROM sessions WHERE token = $1', [token]); },

    async listCharacters(accountId) {
      return (await q('SELECT * FROM characters WHERE account_id = $1 ORDER BY id', [accountId])).rows.map(mapChar);
    },
    async countCharacters(accountId) {
      return (await q('SELECT count(*)::int AS n FROM characters WHERE account_id = $1', [accountId])).rows[0].n;
    },
    async createCharacter(accountId, c) {
      const r = await q(
        `INSERT INTO characters (account_id, name, class, faction, stat_str, stat_dex, stat_int, stat_vit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ((lower(name))) DO NOTHING RETURNING *`,
        [accountId, c.name, c.cls, c.faction, c.str, c.dex, c.int, c.vit],
      );
      return mapChar(r.rows[0]);
    },
    async getCharacter(id) {
      return mapChar((await q('SELECT * FROM characters WHERE id = $1', [id])).rows[0]);
    },
    async saveCharacter(c) {
      const cols = charColumns(c);
      const keys = Object.keys(cols);
      await q(
        `UPDATE characters SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [c.id, ...keys.map((k) => cols[k])],
      );
    },
    async deleteCharacter(id, accountId) {
      const r = await q('DELETE FROM characters WHERE id = $1 AND account_id = $2', [id, accountId]);
      return r.rowCount === 1;
    },

    async getInventory(charId) {
      return (await q('SELECT * FROM inventory WHERE character_id = $1 ORDER BY container, slot', [charId])).rows.map(mapItem);
    },
    // Envanterin tamamını tek işlemde (transaction) yazar: ya hepsi kaydedilir ya hiçbiri.
    async saveInventory(charId, items) {
      await tx(async (c) => {
        await c.query('DELETE FROM inventory WHERE character_id = $1', [charId]);
        for (const it of items) {
          const row = itemColumns(it);
          const keys = Object.keys(row);
          await c.query(
            `INSERT INTO inventory (character_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => '$' + (i + 2)).join(', ')})`,
            [charId, ...keys.map((k) => row[k])],
          );
        }
      });
    },
    async getSkills(charId) {
      return (await q('SELECT skill_id, level, grade FROM skills WHERE character_id = $1', [charId])).rows
        .map((r) => ({ skillId: Number(r.skill_id), level: Number(r.level), grade: Number(r.grade) }));
    },
    async saveSkills(charId, skills) {
      await tx(async (c) => {
        await c.query('DELETE FROM skills WHERE character_id = $1', [charId]);
        for (const s of skills) {
          await c.query('INSERT INTO skills (character_id, skill_id, level, grade) VALUES ($1,$2,$3,$4)', [charId, s.skillId, s.level, s.grade]);
        }
      });
    },

    async logSecurity(accountId, charId, kind, detail) {
      await q('INSERT INTO security_log (account_id, character_id, kind, detail) VALUES ($1,$2,$3,$4)',
        [accountId || null, charId || null, kind, detail || null]);
    },
  };
}

// =====================================================================
// Dosya (geliştirme için) - PostgreSQL ile aynı davranış
// =====================================================================
function createFile() {
  const file = path.join(__dirname, 'data', 'db.json');
  let d = { seq: {}, accounts: [], sessions: [], characters: [], inventory: [], skills: [], security_log: [] };
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(loaded.accounts)) d = { ...d, ...loaded };
  } catch {}
  let timer = null;
  const flush = () => {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(d));
    fs.renameSync(file + '.tmp', file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 300); };
  process.on('exit', () => { if (timer) flush(); });
  const nextId = (t) => (d.seq[t] = (d.seq[t] || 0) + 1);
  const now = () => new Date().toISOString();
  const lc = (s) => String(s).toLowerCase();
  const clone = (o) => JSON.parse(JSON.stringify(o));

  return {
    kind: 'dosya (data/db.json)',
    ready: Promise.resolve(),

    async createAccount(username, hash, salt) {
      if (d.accounts.some((a) => lc(a.username) === lc(username))) return null;
      const row = { id: nextId('accounts'), username, pass_hash: hash, pass_salt: salt, status: 0, faction: null, created_at: now(), last_login: null };
      d.accounts.push(row); save();
      return mapAccount(row);
    },
    async getAccountByName(username) { return mapAccount(d.accounts.find((a) => lc(a.username) === lc(username))); },
    async getAccount(id) { return mapAccount(d.accounts.find((a) => String(a.id) === String(id))); },
    async touchLogin(id) { const a = d.accounts.find((x) => String(x.id) === String(id)); if (a) { a.last_login = now(); save(); } },
    async setFaction(id, faction) { const a = d.accounts.find((x) => String(x.id) === String(id)); if (a) { a.faction = faction; save(); } },

    async createSession(accountId, token) {
      d.sessions.push({ token, account_id: Number(accountId), created_at: Date.now() });
      const mine = d.sessions.filter((s) => String(s.account_id) === String(accountId)).sort((a, b) => b.created_at - a.created_at);
      const drop = new Set(mine.slice(MAX_SESSIONS).map((s) => s.token));
      d.sessions = d.sessions.filter((s) => !drop.has(s.token));
      save();
    },
    async getSessionAccount(token) { const s = d.sessions.find((x) => x.token === token); return s ? String(s.account_id) : null; },
    async deleteSession(token) { d.sessions = d.sessions.filter((s) => s.token !== token); save(); },

    async listCharacters(accountId) { return d.characters.filter((c) => String(c.account_id) === String(accountId)).map(mapChar); },
    async countCharacters(accountId) { return d.characters.filter((c) => String(c.account_id) === String(accountId)).length; },
    async createCharacter(accountId, c) {
      if (d.characters.some((x) => lc(x.name) === lc(c.name))) return null;
      const row = {
        id: nextId('characters'), account_id: Number(accountId), name: c.name, class: c.cls, faction: c.faction,
        level: 1, exp: 0, alignment: 0, map_id: 1, pos_x: null, pos_y: null, pos_z: 0,
        stat_str: c.str, stat_dex: c.dex, stat_int: c.int, stat_vit: c.vit, stat_points: 0,
        gold: 0, kills: 0, deaths: 0, play_seconds: 0, created_at: now(), updated_at: now(),
      };
      d.characters.push(row); save();
      return mapChar(row);
    },
    async getCharacter(id) { return mapChar(d.characters.find((c) => String(c.id) === String(id))); },
    async saveCharacter(c) {
      const row = d.characters.find((x) => String(x.id) === String(c.id));
      if (!row) return;
      Object.assign(row, charColumns(c), { updated_at: now() });
      save();
    },
    async deleteCharacter(id, accountId) {
      const before = d.characters.length;
      d.characters = d.characters.filter((c) => !(String(c.id) === String(id) && String(c.account_id) === String(accountId)));
      if (d.characters.length === before) return false;
      d.inventory = d.inventory.filter((i) => String(i.character_id) !== String(id));
      d.skills = d.skills.filter((s) => String(s.character_id) !== String(id));
      save();
      return true;
    },

    async getInventory(charId) {
      return d.inventory.filter((i) => String(i.character_id) === String(charId))
        .sort((a, b) => a.container - b.container || a.slot - b.slot).map((r) => mapItem(clone(r)));
    },
    async saveInventory(charId, items) {
      d.inventory = d.inventory.filter((i) => String(i.character_id) !== String(charId));
      for (const it of items) d.inventory.push({ uid: it.uid || nextId('inventory'), character_id: Number(charId), ...itemColumns(it) });
      save();
    },
    async getSkills(charId) {
      return d.skills.filter((s) => String(s.character_id) === String(charId))
        .map((r) => ({ skillId: r.skill_id, level: r.level, grade: r.grade }));
    },
    async saveSkills(charId, skills) {
      d.skills = d.skills.filter((s) => String(s.character_id) !== String(charId));
      for (const s of skills) d.skills.push({ character_id: Number(charId), skill_id: s.skillId, level: s.level, grade: s.grade });
      save();
    },
    async logSecurity(accountId, charId, kind, detail) {
      d.security_log.push({ id: nextId('security_log'), account_id: accountId || null, character_id: charId || null, kind, detail: detail || null, created_at: now() });
      if (d.security_log.length > 5000) d.security_log.splice(0, 1000);
      save();
    },
  };
}

module.exports = process.env.DATABASE_URL ? createPg(process.env.DATABASE_URL) : createFile();
