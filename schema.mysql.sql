-- Run with XAMPP MySQL:
-- C:\xampp\mysql\bin\mysql.exe -u root < schema.mysql.sql
-- (the schema creates and selects the coc_tracker database itself)

CREATE DATABASE IF NOT EXISTS coc_tracker CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE coc_tracker;

CREATE TABLE IF NOT EXISTS members (
  tag VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  role VARCHAR(32),
  town_hall INT,
  trophies INT,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS wars (
  id INT AUTO_INCREMENT PRIMARY KEY,
  external_key VARCHAR(128) UNIQUE,
  opponent_name VARCHAR(128),
  opponent_tag VARCHAR(32),
  team_size INT,
  start_time TIMESTAMP NULL,
  end_time TIMESTAMP NULL,
  result VARCHAR(16),
  stars_for INT DEFAULT 0,
  stars_against INT DEFAULT 0,
  destruction_for DECIMAL(5,2) DEFAULT 0,
  destruction_against DECIMAL(5,2) DEFAULT 0,
  is_cwl BOOLEAN DEFAULT FALSE,
  notes TEXT,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS war_attacks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  war_id INT NOT NULL,
  attacker_tag VARCHAR(32),
  attacker_name VARCHAR(128),
  defender_tag VARCHAR(32),
  defender_name VARCHAR(128),
  stars INT,
  destruction DECIMAL(5,2),
  `order` INT,
  duration INT,
  side VARCHAR(8) DEFAULT 'enemy',
  FOREIGN KEY (war_id) REFERENCES wars(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS raid_weekends (
  id INT AUTO_INCREMENT PRIMARY KEY,
  external_key VARCHAR(128) UNIQUE,
  start_time TIMESTAMP NULL,
  end_time TIMESTAMP NULL,
  raids_completed INT DEFAULT 0,
  total_capital_gold BIGINT DEFAULT 0,
  total_raid_medals BIGINT DEFAULT 0,
  total_attacks INT DEFAULT 0,
  districts_destroyed INT DEFAULT 0,
  notes TEXT,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capital_raids (
  id INT AUTO_INCREMENT PRIMARY KEY,
  raid_id INT NOT NULL,
  member_tag VARCHAR(32),
  member_name VARCHAR(128),
  hall_level INT,
  attacks INT,
  capital_gold BIGINT DEFAULT 0,
  raid_medals BIGINT DEFAULT 0,
  districts_destroyed INT DEFAULT 0,
  FOREIGN KEY (raid_id) REFERENCES raid_weekends(id) ON DELETE CASCADE,
  UNIQUE KEY uq_raid_member (raid_id, member_tag)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sync_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  endpoint VARCHAR(128),
  items_fetched INT DEFAULT 0,
  status VARCHAR(16),
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

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
  captured_at TIMESTAMP NULL,
  latest_at TIMESTAMP NULL,
  PRIMARY KEY (member_tag, day)
) ENGINE=InnoDB;
