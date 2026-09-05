-- Create the database used by the clan activity tracker.
CREATE DATABASE IF NOT EXISTS coc_clan_tracker
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE coc_clan_tracker;

-- Stores the administrator account and its simulated confirmation state.
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_code VARCHAR(64) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

-- Stores the clan member roster.
CREATE TABLE IF NOT EXISTS members (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_tag VARCHAR(15) NOT NULL DEFAULT 'N/A',
  player_name VARCHAR(100) NOT NULL,
  town_hall_level TINYINT UNSIGNED NOT NULL,
  role ENUM('leader', 'co-leader', 'elder', 'member') NOT NULL DEFAULT 'member',
  PRIMARY KEY (id),
  UNIQUE KEY uq_members_player_tag (player_tag),
  CONSTRAINT chk_members_town_hall_level
    CHECK (town_hall_level BETWEEN 1 AND 18)
) ENGINE=InnoDB;

-- Records each member’s war attack activity.
CREATE TABLE IF NOT EXISTS war_logs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id INT UNSIGNED NOT NULL,
  war_date DATE NOT NULL,
  attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0,
  missed_attack BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  UNIQUE KEY uq_war_logs_member_date (member_id, war_date),
  CONSTRAINT fk_war_logs_member
    FOREIGN KEY (member_id) REFERENCES members (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT chk_war_logs_attacks_used
    CHECK (attacks_used BETWEEN 0 AND 2)
) ENGINE=InnoDB;

-- Records each member’s Clan Capital raid-weekend activity.
CREATE TABLE IF NOT EXISTS capital_logs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id INT UNSIGNED NOT NULL,
  raid_weekend_date DATE NOT NULL,
  attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0,
  capital_gold_looted INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_capital_logs_member_date (member_id, raid_weekend_date),
  CONSTRAINT fk_capital_logs_member
    FOREIGN KEY (member_id) REFERENCES members (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT chk_capital_logs_attacks_used
    CHECK (attacks_used BETWEEN 0 AND 6)
) ENGINE=InnoDB;

-- Stores app-wide settings such as the customizable background image.
CREATE TABLE IF NOT EXISTS settings (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bg_image_url VARCHAR(2048) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- Ensure the application always has one settings row to update.
INSERT INTO settings (id, bg_image_url)
VALUES (1, NULL)
ON DUPLICATE KEY UPDATE id = id;

CREATE TABLE IF NOT EXISTS war_sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_name VARCHAR(100) NOT NULL,
  session_date DATE NOT NULL,
  status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capital_sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_name VARCHAR(100) NOT NULL,
  session_date DATE NOT NULL,
  status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS war_attendance (
  session_id INT UNSIGNED NOT NULL,
  member_id INT UNSIGNED NOT NULL,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('present', 'absent', 'unmarked') NOT NULL DEFAULT 'unmarked',
  attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, member_id),
  CONSTRAINT fk_war_attendance_session FOREIGN KEY (session_id) REFERENCES war_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_war_attendance_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT chk_war_attendance_attacks CHECK (attacks_used BETWEEN 0 AND 2)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS capital_attendance (
  session_id INT UNSIGNED NOT NULL,
  member_id INT UNSIGNED NOT NULL,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('present', 'absent', 'unmarked') NOT NULL DEFAULT 'unmarked',
  attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, member_id),
  CONSTRAINT fk_capital_attendance_session FOREIGN KEY (session_id) REFERENCES capital_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_capital_attendance_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  CONSTRAINT chk_capital_attendance_attacks CHECK (attacks_used BETWEEN 0 AND 6)
) ENGINE=InnoDB;
