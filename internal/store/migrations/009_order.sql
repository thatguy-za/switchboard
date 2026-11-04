ALTER TABLE folders ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Start from the order people already see: alphabetical within each folder.
UPDATE folders SET position = (
	SELECT COUNT(*) FROM folders f
	WHERE f.user_id = folders.user_id AND COALESCE(f.parent_id, '') = COALESCE(folders.parent_id, '')
	  AND (f.name < folders.name OR (f.name = folders.name AND f.id < folders.id)));
UPDATE hosts SET position = (
	SELECT COUNT(*) FROM hosts h
	WHERE h.user_id = hosts.user_id AND COALESCE(h.folder_id, '') = COALESCE(hosts.folder_id, '')
	  AND (h.name < hosts.name OR (h.name = hosts.name AND h.id < hosts.id)));
