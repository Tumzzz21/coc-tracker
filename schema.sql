-- PostgreSQL schema for Supabase and local PostgreSQL.
-- Run this in Supabase SQL Editor or with psql.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_code VARCHAR(64),
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id BIGSERIAL PRIMARY KEY,
  player_tag VARCHAR(15) NOT NULL DEFAULT 'N/A',
  player_name VARCHAR(100) NOT NULL,
  town_hall_level SMALLINT NOT NULL CHECK (town_hall_level BETWEEN 1 AND 18),
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('leader', 'co-leader', 'elder', 'member'))
);

CREATE TABLE IF NOT EXISTS war_logs (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES members(id) ON UPDATE CASCADE ON DELETE CASCADE,
  war_date DATE NOT NULL,
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 2),
  missed_attack BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (member_id, war_date)
);

CREATE TABLE IF NOT EXISTS capital_logs (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES members(id) ON UPDATE CASCADE ON DELETE CASCADE,
  raid_weekend_date DATE NOT NULL,
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 6),
  capital_gold_looted INTEGER NOT NULL DEFAULT 0 CHECK (capital_gold_looted >= 0),
  UNIQUE (member_id, raid_weekend_date)
);

CREATE TABLE IF NOT EXISTS settings (
  id BIGINT PRIMARY KEY,
  bg_image_url VARCHAR(2048)
);

INSERT INTO settings (id, bg_image_url)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS war_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_name VARCHAR(100) NOT NULL,
  session_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS capital_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_name VARCHAR(100) NOT NULL,
  session_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS war_attendance (
  session_id BIGINT NOT NULL REFERENCES war_sessions(id) ON DELETE CASCADE,
  member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'unmarked' CHECK (status IN ('present', 'absent', 'unmarked')),
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 2),
  PRIMARY KEY (session_id, member_id)
);

CREATE TABLE IF NOT EXISTS capital_attendance (
  session_id BIGINT NOT NULL REFERENCES capital_sessions(id) ON DELETE CASCADE,
  member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'unmarked' CHECK (status IN ('present', 'absent', 'unmarked')),
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 6),
  PRIMARY KEY (session_id, member_id)
);
