-- D1 schema for shared sheets. Run once in the Cloudflare dashboard (D1 → your database → Console).
CREATE TABLE IF NOT EXISTS sheets (
  slug            TEXT PRIMARY KEY,
  character_id    INTEGER NOT NULL UNIQUE,
  character_name  TEXT NOT NULL,
  include         TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
