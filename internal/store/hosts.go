package store

import (
	"database/sql"
	"errors"
	"time"
)

type Folder struct{ ID, UserID, ParentID, Name string }

type Host struct {
	ID, UserID, FolderID, Name, Address string
	Port                                int
	Username, Auth, IdentityID          string
	PasswordBlob                        []byte
	Protocol, Theme                     string
	CreatedAt                           int64
}

type Identity struct {
	ID, UserID, Name, Comment, Kind, PublicKey, Fingerprint string
	PrivateBlob                                             []byte
	CreatedAt                                               int64
}

type KnownHost struct{ KeyType, Fingerprint string }

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func found(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

/* folders */

func (s *Store) ListFolders(userID string) ([]*Folder, error) {
	rows, err := s.db.Query(`SELECT id, user_id, COALESCE(parent_id, ''), name FROM folders WHERE user_id=? ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Folder
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.UserID, &f.ParentID, &f.Name); err != nil {
			return nil, err
		}
		out = append(out, &f)
	}
	return out, rows.Err()
}

func (s *Store) GetFolder(id, userID string) (*Folder, error) {
	var f Folder
	err := s.db.QueryRow(`SELECT id, user_id, COALESCE(parent_id, ''), name FROM folders WHERE id=? AND user_id=?`, id, userID).
		Scan(&f.ID, &f.UserID, &f.ParentID, &f.Name)
	return &f, found(err)
}

func (s *Store) CreateFolder(f *Folder) error {
	_, err := s.db.Exec(`INSERT INTO folders (id, user_id, parent_id, name) VALUES (?,?,?,?)`,
		f.ID, f.UserID, nullable(f.ParentID), f.Name)
	return err
}

func (s *Store) UpdateFolder(f *Folder) error {
	_, err := s.db.Exec(`UPDATE folders SET parent_id=?, name=? WHERE id=? AND user_id=?`,
		nullable(f.ParentID), f.Name, f.ID, f.UserID)
	return err
}

func (s *Store) DeleteFolder(id, userID string) error {
	res, err := s.db.Exec(`DELETE FROM folders WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

/* hosts */

const hostCols = `id, user_id, COALESCE(folder_id, ''), name, address, port, username, auth,
	COALESCE(identity_id, ''), password_blob, protocol, theme, created_at`

func scanHost(r scanner) (*Host, error) {
	var h Host
	err := r.Scan(&h.ID, &h.UserID, &h.FolderID, &h.Name, &h.Address, &h.Port, &h.Username, &h.Auth,
		&h.IdentityID, &h.PasswordBlob, &h.Protocol, &h.Theme, &h.CreatedAt)
	return &h, found(err)
}

func (s *Store) ListHosts(userID string) ([]*Host, error) {
	rows, err := s.db.Query(`SELECT `+hostCols+` FROM hosts WHERE user_id=? ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Host
	for rows.Next() {
		h, err := scanHost(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *Store) GetHost(id, userID string) (*Host, error) {
	return scanHost(s.db.QueryRow(`SELECT `+hostCols+` FROM hosts WHERE id=? AND user_id=?`, id, userID))
}

func (s *Store) CreateHost(h *Host) error {
	h.CreatedAt = time.Now().Unix()
	_, err := s.db.Exec(`INSERT INTO hosts (id, user_id, folder_id, name, address, port, username, auth,
		identity_id, password_blob, protocol, theme, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		h.ID, h.UserID, nullable(h.FolderID), h.Name, h.Address, h.Port, h.Username, h.Auth,
		nullable(h.IdentityID), h.PasswordBlob, h.Protocol, h.Theme, h.CreatedAt)
	return err
}

func (s *Store) UpdateHost(h *Host) error {
	_, err := s.db.Exec(`UPDATE hosts SET folder_id=?, name=?, address=?, port=?, username=?, auth=?,
		identity_id=?, password_blob=?, theme=? WHERE id=? AND user_id=?`,
		nullable(h.FolderID), h.Name, h.Address, h.Port, h.Username, h.Auth,
		nullable(h.IdentityID), h.PasswordBlob, h.Theme, h.ID, h.UserID)
	return err
}

func (s *Store) DeleteHost(id, userID string) error {
	res, err := s.db.Exec(`DELETE FROM hosts WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

/* identities */

const identityCols = `id, user_id, name, comment, kind, public_key, fingerprint, private_blob, created_at`

func scanIdentity(r scanner) (*Identity, error) {
	var i Identity
	err := r.Scan(&i.ID, &i.UserID, &i.Name, &i.Comment, &i.Kind, &i.PublicKey, &i.Fingerprint, &i.PrivateBlob, &i.CreatedAt)
	return &i, found(err)
}

func (s *Store) ListIdentities(userID string) ([]*Identity, error) {
	rows, err := s.db.Query(`SELECT `+identityCols+` FROM identities WHERE user_id=? ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Identity
	for rows.Next() {
		i, err := scanIdentity(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) GetIdentity(id, userID string) (*Identity, error) {
	return scanIdentity(s.db.QueryRow(`SELECT `+identityCols+` FROM identities WHERE id=? AND user_id=?`, id, userID))
}

func (s *Store) CreateIdentity(i *Identity) error {
	i.CreatedAt = time.Now().Unix()
	_, err := s.db.Exec(`INSERT INTO identities (`+identityCols+`) VALUES (?,?,?,?,?,?,?,?,?)`,
		i.ID, i.UserID, i.Name, i.Comment, i.Kind, i.PublicKey, i.Fingerprint, i.PrivateBlob, i.CreatedAt)
	return err
}

func (s *Store) DeleteIdentity(id, userID string) error {
	res, err := s.db.Exec(`DELETE FROM identities WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

/* known hosts */

func (s *Store) KnownHost(hostID string) (*KnownHost, error) {
	var k KnownHost
	err := s.db.QueryRow(`SELECT key_type, fingerprint FROM known_hosts WHERE host_id=?`, hostID).Scan(&k.KeyType, &k.Fingerprint)
	return &k, found(err)
}

func (s *Store) SetKnownHost(hostID, keyType, fingerprint string) error {
	_, err := s.db.Exec(`INSERT INTO known_hosts (host_id, key_type, fingerprint) VALUES (?,?,?)
		ON CONFLICT(host_id) DO UPDATE SET key_type=excluded.key_type, fingerprint=excluded.fingerprint`,
		hostID, keyType, fingerprint)
	return err
}

/* jump hosts and port forwards */

type Forward struct {
	Kind     string
	BindPort int
	DestHost string
	DestPort int
}

// JumpsByHost returns every jump chain a user has, keyed by host ID, in hop order.
func (s *Store) JumpsByHost(userID string) (map[string][]string, error) {
	rows, err := s.db.Query(`SELECT j.host_id, j.jump_id FROM host_jumps j
		JOIN hosts h ON h.id = j.host_id WHERE h.user_id=? ORDER BY j.host_id, j.position`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var host, jump string
		if err := rows.Scan(&host, &jump); err != nil {
			return nil, err
		}
		out[host] = append(out[host], jump)
	}
	return out, rows.Err()
}

func (s *Store) SetJumps(hostID string, ids []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM host_jumps WHERE host_id=?`, hostID); err != nil {
		return err
	}
	for i, id := range ids {
		if _, err := tx.Exec(`INSERT INTO host_jumps (host_id, position, jump_id) VALUES (?,?,?)`, hostID, i, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ForwardsByHost(userID string) (map[string][]Forward, error) {
	rows, err := s.db.Query(`SELECT f.host_id, f.kind, f.bind_port, f.dest_host, f.dest_port FROM host_forwards f
		JOIN hosts h ON h.id = f.host_id WHERE h.user_id=? ORDER BY f.host_id, f.position`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]Forward{}
	for rows.Next() {
		var host string
		var f Forward
		if err := rows.Scan(&host, &f.Kind, &f.BindPort, &f.DestHost, &f.DestPort); err != nil {
			return nil, err
		}
		out[host] = append(out[host], f)
	}
	return out, rows.Err()
}

func (s *Store) SetForwards(hostID string, fs []Forward) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM host_forwards WHERE host_id=?`, hostID); err != nil {
		return err
	}
	for i, f := range fs {
		if _, err := tx.Exec(`INSERT INTO host_forwards (host_id, position, kind, bind_port, dest_host, dest_port)
			VALUES (?,?,?,?,?,?)`, hostID, i, f.Kind, f.BindPort, f.DestHost, f.DestPort); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ChainFor returns a host's jump host IDs and forwards, for a connection.
func (s *Store) ChainFor(hostID string) (jumps []string, forwards []Forward, err error) {
	rows, err := s.db.Query(`SELECT jump_id FROM host_jumps WHERE host_id=? ORDER BY position`, hostID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, err
		}
		jumps = append(jumps, id)
	}
	rows.Close()
	frows, err := s.db.Query(`SELECT kind, bind_port, dest_host, dest_port FROM host_forwards WHERE host_id=? ORDER BY position`, hostID)
	if err != nil {
		return nil, nil, err
	}
	defer frows.Close()
	for frows.Next() {
		var f Forward
		if err := frows.Scan(&f.Kind, &f.BindPort, &f.DestHost, &f.DestPort); err != nil {
			return nil, nil, err
		}
		forwards = append(forwards, f)
	}
	return jumps, forwards, frows.Err()
}

/* key push */

// SetHostIdentity makes a host sign in with an identity. A saved password is kept.
func (s *Store) SetHostIdentity(hostID, userID, identityID string) error {
	_, err := s.db.Exec(`UPDATE hosts SET auth='key', identity_id=? WHERE id=? AND user_id=?`, identityID, hostID, userID)
	return err
}

func (s *Store) RecordDeployment(identityID, hostID string) error {
	_, err := s.db.Exec(`INSERT INTO identity_deployments (identity_id, host_id, deployed_at) VALUES (?,?,?)
		ON CONFLICT(identity_id, host_id) DO UPDATE SET deployed_at=excluded.deployed_at`,
		identityID, hostID, time.Now().Unix())
	return err
}

// DeploymentsByIdentity maps each of a user's identities to the host IDs it was pushed to.
func (s *Store) DeploymentsByIdentity(userID string) (map[string][]string, error) {
	rows, err := s.db.Query(`SELECT d.identity_id, d.host_id FROM identity_deployments d
		JOIN identities i ON i.id = d.identity_id WHERE i.user_id=? ORDER BY d.deployed_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var identity, host string
		if err := rows.Scan(&identity, &host); err != nil {
			return nil, err
		}
		out[identity] = append(out[identity], host)
	}
	return out, rows.Err()
}
