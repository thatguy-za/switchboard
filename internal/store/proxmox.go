package store

import "time"

// ProxmoxServer is a Proxmox VE server a user has connected. The token secret is sealed with
// the user's vault key, and the certificate fingerprint is the one pinned when it was added.
type ProxmoxServer struct {
	ID, UserID, Address, TokenID, Fingerprint string
	SecretBlob                                []byte
}

func (s *Store) ListProxmoxServers(userID string) ([]*ProxmoxServer, error) {
	rows, err := s.db.Query(`SELECT id, user_id, address, token_id, secret_blob, fingerprint FROM proxmox_servers WHERE user_id=? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ProxmoxServer
	for rows.Next() {
		p := &ProxmoxServer{}
		if err := rows.Scan(&p.ID, &p.UserID, &p.Address, &p.TokenID, &p.SecretBlob, &p.Fingerprint); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProxmoxServer(id, userID string) (*ProxmoxServer, error) {
	p := &ProxmoxServer{}
	err := s.db.QueryRow(`SELECT id, user_id, address, token_id, secret_blob, fingerprint FROM proxmox_servers WHERE id=? AND user_id=?`, id, userID).
		Scan(&p.ID, &p.UserID, &p.Address, &p.TokenID, &p.SecretBlob, &p.Fingerprint)
	return p, found(err)
}

func (s *Store) CreateProxmoxServer(p *ProxmoxServer) error {
	_, err := s.db.Exec(`INSERT INTO proxmox_servers (id, user_id, address, token_id, secret_blob, fingerprint, created_at) VALUES (?,?,?,?,?,?,?)`,
		p.ID, p.UserID, p.Address, p.TokenID, p.SecretBlob, p.Fingerprint, time.Now().Unix())
	return err
}

// DeleteProxmoxServer removes a server and unlinks the hosts that pointed at it.
func (s *Store) DeleteProxmoxServer(id, userID string) error {
	if _, err := s.db.Exec(`UPDATE hosts SET proxmox_server_id=NULL, proxmox_vmid=0, proxmox_type='' WHERE proxmox_server_id=? AND user_id=?`, id, userID); err != nil {
		return err
	}
	res, err := s.db.Exec(`DELETE FROM proxmox_servers WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
