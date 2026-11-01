CREATE TABLE folders (
	id        TEXT PRIMARY KEY,
	user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
	name      TEXT NOT NULL
);
CREATE INDEX folders_user ON folders(user_id);

CREATE TABLE identities (
	id           TEXT PRIMARY KEY,
	user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name         TEXT NOT NULL,
	comment      TEXT NOT NULL DEFAULT '',
	kind         TEXT NOT NULL CHECK (kind IN ('ed25519', 'rsa')),
	public_key   TEXT NOT NULL,
	fingerprint  TEXT NOT NULL,
	private_blob BLOB NOT NULL,
	created_at   INTEGER NOT NULL
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE hosts (
	id            TEXT PRIMARY KEY,
	user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
	name          TEXT NOT NULL,
	address       TEXT NOT NULL,
	port          INTEGER NOT NULL DEFAULT 22,
	username      TEXT NOT NULL DEFAULT '',
	auth          TEXT NOT NULL CHECK (auth IN ('password', 'key')),
	identity_id   TEXT REFERENCES identities(id) ON DELETE SET NULL,
	password_blob BLOB,
	protocol      TEXT NOT NULL DEFAULT 'ssh',
	theme         TEXT NOT NULL DEFAULT 'auto',
	created_at    INTEGER NOT NULL
);
CREATE INDEX hosts_user ON hosts(user_id);

CREATE TABLE known_hosts (
	host_id     TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
	key_type    TEXT NOT NULL,
	fingerprint TEXT NOT NULL
);
