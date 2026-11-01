CREATE TABLE host_jumps (
	host_id  TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	jump_id  TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
	PRIMARY KEY (host_id, position)
);

CREATE TABLE host_forwards (
	host_id   TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
	position  INTEGER NOT NULL,
	kind      TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
	bind_port INTEGER NOT NULL,
	dest_host TEXT NOT NULL,
	dest_port INTEGER NOT NULL,
	PRIMARY KEY (host_id, position)
);
