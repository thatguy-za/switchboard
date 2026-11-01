CREATE TABLE users (
	id           TEXT PRIMARY KEY,
	username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
	role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
	pw_hash      TEXT NOT NULL,
	kek_salt     BLOB NOT NULL,
	wrapped_vk   BLOB NOT NULL,
	recovery_vk  BLOB,
	must_change  INTEGER NOT NULL DEFAULT 0,
	totp_secret  BLOB,
	totp_enabled INTEGER NOT NULL DEFAULT 0,
	totp_step    INTEGER NOT NULL DEFAULT 0,
	failed       INTEGER NOT NULL DEFAULT 0,
	locked_until INTEGER NOT NULL DEFAULT 0,
	created_at   INTEGER NOT NULL
);

CREATE TABLE backup_codes (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	hash    BLOB NOT NULL,
	used    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX backup_codes_user ON backup_codes(user_id);

CREATE TABLE settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
