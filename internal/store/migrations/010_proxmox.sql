CREATE TABLE proxmox_servers (
	id          TEXT PRIMARY KEY,
	user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	address     TEXT NOT NULL,
	token_id    TEXT NOT NULL,
	secret_blob BLOB NOT NULL,
	fingerprint TEXT NOT NULL,
	created_at  INTEGER NOT NULL
);
CREATE INDEX proxmox_servers_user ON proxmox_servers(user_id);

ALTER TABLE hosts ADD COLUMN proxmox_server_id TEXT REFERENCES proxmox_servers(id) ON DELETE SET NULL;
ALTER TABLE hosts ADD COLUMN proxmox_vmid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosts ADD COLUMN proxmox_type TEXT NOT NULL DEFAULT '';
