CREATE TABLE identity_deployments (
	identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
	host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
	deployed_at INTEGER NOT NULL,
	PRIMARY KEY (identity_id, host_id)
);
