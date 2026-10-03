-- CoC Attack Tracker schema — PostgreSQL (Supabase / Vercel)
CREATE TABLE IF NOT EXISTS members (
  tag VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  role VARCHAR(32),
  town_hall INT,
  trophies INT,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wars (
  id SERIAL PRIMARY KEY,
  external_key VARCHAR(128) UNIQUE,
  opponent_name VARCHAR(128),
  opponent_tag VARCHAR(32),
  team_size INT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  result VARCHAR(16),
  stars_for INT DEFAULT 0,
  stars_against INT DEFAULT 0,
  destruction_for DECIMAL(5,2) DEFAULT 0,
  destruction_against DECIMAL(5,2) DEFAULT 0,
  is_cwl BOOLEAN DEFAULT FALSE,
  notes TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS war_attacks (
  id SERIAL PRIMARY KEY,
  war_id INT NOT NULL REFERENCES wars(id) ON DELETE CASCADE,
  attacker_tag VARCHAR(32),
  attacker_name VARCHAR(128),
  defender_tag VARCHAR(32),
  defender_name VARCHAR(128),
  stars INT,
  destruction DECIMAL(5,2),
  "order" INT,
  duration INT,
  side VARCHAR(8) DEFAULT 'enemy'
);

CREATE TABLE IF NOT EXISTS raid_weekends (
  id SERIAL PRIMARY KEY,
  external_key VARCHAR(128) UNIQUE,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  raids_completed INT DEFAULT 0,
  total_capital_gold BIGINT DEFAULT 0,
  total_raid_medals BIGINT DEFAULT 0,
  total_attacks INT DEFAULT 0,
  districts_destroyed INT DEFAULT 0,
  notes TEXT,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capital_raids (
  id SERIAL PRIMARY KEY,
  raid_id INT NOT NULL REFERENCES raid_weekends(id) ON DELETE CASCADE,
  member_tag VARCHAR(32),
  member_name VARCHAR(128),
  hall_level INT,
  attacks INT,
  capital_gold BIGINT DEFAULT 0,
  raid_medals BIGINT DEFAULT 0,
  districts_destroyed INT DEFAULT 0,
  UNIQUE (raid_id, member_tag)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id SERIAL PRIMARY KEY,
  endpoint VARCHAR(128),
  items_fetched INT DEFAULT 0,
  status VARCHAR(16),
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Capital-coin contributions per member, bucketed by the server's local day.
--
-- `clanCapitalContributions` is a LIFETIME total and is only exposed on the
-- player endpoint (/players/{tag}), so the API is polled once per member.
--
--   total_contributions  = the FIRST reading of the day (baseline).
--                          Donated during day D = baseline(D) - baseline(D-1),
--                          i.e. an exact ~24h window.
--   latest_contributions = the most recent reading of the day ("so far today").
CREATE TABLE IF NOT EXISTS member_contributions (
  member_tag VARCHAR(32) NOT NULL,
  day DATE NOT NULL,
  total_contributions BIGINT DEFAULT 0,
  latest_contributions BIGINT DEFAULT 0,
  member_name VARCHAR(128),
  captured_at TIMESTAMPTZ NULL,
  latest_at TIMESTAMPTZ NULL,
  PRIMARY KEY (member_tag, day)
);
