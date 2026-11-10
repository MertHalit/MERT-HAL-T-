-- PvP Server veritabanı şeması (PostgreSQL)
-- Sunucu her açılışta bu dosyayı çalıştırır; tüm komutlar tekrar çalıştırılabilir (IF NOT EXISTS).

-- ---------------- HESAPLAR ----------------
CREATE TABLE IF NOT EXISTS accounts (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT        NOT NULL,
  pass_hash    TEXT        NOT NULL,              -- scrypt özeti (hex)
  pass_salt    TEXT        NOT NULL,
  status       SMALLINT    NOT NULL DEFAULT 0,    -- 0: aktif, 1: engelli (ban), 2: dondurulmuş
  faction      TEXT        NULL CHECK (faction IN ('kizil', 'gok', 'yesim')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login   TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_uq ON accounts (lower(username));

-- Oturum anahtarları (otomatik giriş). Hesap başına en fazla 5 cihaz tutulur.
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  account_id   BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id, created_at DESC);

-- ---------------- KARAKTERLER ----------------
CREATE TABLE IF NOT EXISTS characters (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  class        TEXT        NOT NULL CHECK (class IN ('savasci', 'golge', 'buyucu', 'saman')),
  faction      TEXT        NOT NULL CHECK (faction IN ('kizil', 'gok', 'yesim')),
  level        SMALLINT    NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 120),
  exp          BIGINT      NOT NULL DEFAULT 0 CHECK (exp >= 0),
  alignment    INTEGER     NOT NULL DEFAULT 0,    -- ahlak derecesi: + iyi, - kötü (masum öldürünce düşer)
  map_id       INTEGER     NOT NULL DEFAULT 1,
  pos_x        REAL        NULL,
  pos_y        REAL        NULL,
  pos_z        REAL        NOT NULL DEFAULT 0,
  stat_str     SMALLINT    NOT NULL DEFAULT 5,
  stat_dex     SMALLINT    NOT NULL DEFAULT 5,
  stat_int     SMALLINT    NOT NULL DEFAULT 5,
  stat_vit     SMALLINT    NOT NULL DEFAULT 5,
  stat_points  SMALLINT    NOT NULL DEFAULT 0,    -- dağıtılmamış statü puanı
  gold         BIGINT      NOT NULL DEFAULT 0 CHECK (gold >= 0),
  kills        INTEGER     NOT NULL DEFAULT 0,
  deaths       INTEGER     NOT NULL DEFAULT 0,
  play_seconds BIGINT      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS characters_name_uq ON characters (lower(name));
CREATE INDEX IF NOT EXISTS characters_account_idx ON characters (account_id);

-- ---------------- ENVANTER ----------------
-- container: 0 = çanta, 1 = kuşanılmış ekipman, 2 = depo, 3 = pazar tezgahı
-- attrN_type / attrN_value: 1-5 temel efsunlar, 6-7 özel efsunlar (0 = boş)
CREATE TABLE IF NOT EXISTS inventory (
  uid          BIGSERIAL PRIMARY KEY,             -- her eşyanın benzersiz kimliği (kayıt / takas izleme)
  character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  container    SMALLINT    NOT NULL DEFAULT 0,
  slot         SMALLINT    NOT NULL CHECK (slot >= 0),
  item_id      INTEGER     NOT NULL,              -- eşya şablon kimliği
  count        INTEGER     NOT NULL DEFAULT 1 CHECK (count > 0),
  plus         SMALLINT    NOT NULL DEFAULT 0 CHECK (plus BETWEEN 0 AND 9),
  attr1_type SMALLINT NOT NULL DEFAULT 0, attr1_value SMALLINT NOT NULL DEFAULT 0,
  attr2_type SMALLINT NOT NULL DEFAULT 0, attr2_value SMALLINT NOT NULL DEFAULT 0,
  attr3_type SMALLINT NOT NULL DEFAULT 0, attr3_value SMALLINT NOT NULL DEFAULT 0,
  attr4_type SMALLINT NOT NULL DEFAULT 0, attr4_value SMALLINT NOT NULL DEFAULT 0,
  attr5_type SMALLINT NOT NULL DEFAULT 0, attr5_value SMALLINT NOT NULL DEFAULT 0,
  attr6_type SMALLINT NOT NULL DEFAULT 0, attr6_value SMALLINT NOT NULL DEFAULT 0,
  attr7_type SMALLINT NOT NULL DEFAULT 0, attr7_value SMALLINT NOT NULL DEFAULT 0,
  price        BIGINT      NULL,                  -- pazar tezgahındaysa birim fiyat
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, container, slot)
);

-- ---------------- BECERİLER ----------------
-- grade: 0 = Temel, 1 = Usta, 2 = Büyük Usta, 3 = Kusursuz
CREATE TABLE IF NOT EXISTS skills (
  character_id BIGINT   NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  skill_id     SMALLINT NOT NULL,
  level        SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 20),
  grade        SMALLINT NOT NULL DEFAULT 0 CHECK (grade BETWEEN 0 AND 3),
  PRIMARY KEY (character_id, skill_id)
);

-- ---------------- GÜVENLİK KAYITLARI ----------------
-- Hile şüphesi, hızlı paket, geçersiz işlem vb. Admin paneli buradan okuyacak.
CREATE TABLE IF NOT EXISTS security_log (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT      NULL REFERENCES accounts (id) ON DELETE SET NULL,
  character_id BIGINT      NULL REFERENCES characters (id) ON DELETE SET NULL,
  kind         TEXT        NOT NULL,
  detail       TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_log_time_idx ON security_log (created_at DESC);
