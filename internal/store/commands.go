package store

import "time"

// Command is a saved terminal command. The text is sealed with the user's vault
// key; only the name is readable here.
type Command struct {
	ID, UserID, Name string
	Blob             []byte
	Position         int
}

func (s *Store) ListCommands(userID string) ([]*Command, error) {
	rows, err := s.db.Query(`SELECT id, user_id, name, body_blob, position FROM commands WHERE user_id=? ORDER BY position, created_at, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Command
	for rows.Next() {
		c := &Command{}
		if err := rows.Scan(&c.ID, &c.UserID, &c.Name, &c.Blob, &c.Position); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CountCommands(userID string) (n int, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*) FROM commands WHERE user_id=?`, userID).Scan(&n)
	return
}

// CreateCommand adds c at the end of the user's list.
func (s *Store) CreateCommand(c *Command) error {
	_, err := s.db.Exec(`INSERT INTO commands (id, user_id, name, body_blob, position, created_at)
		VALUES (?,?,?,?, COALESCE((SELECT MAX(position)+1 FROM commands WHERE user_id=?), 0), ?)`,
		c.ID, c.UserID, c.Name, c.Blob, c.UserID, time.Now().Unix())
	return err
}

func (s *Store) UpdateCommand(c *Command) error {
	res, err := s.db.Exec(`UPDATE commands SET name=?, body_blob=? WHERE id=? AND user_id=?`, c.Name, c.Blob, c.ID, c.UserID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteCommand(id, userID string) error {
	res, err := s.db.Exec(`DELETE FROM commands WHERE id=? AND user_id=?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ReorderCommands numbers the user's commands in the order given. Ids that are
// not the user's are ignored.
func (s *Store) ReorderCommands(userID string, ids []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, id := range ids {
		if _, err := tx.Exec(`UPDATE commands SET position=? WHERE id=? AND user_id=?`, i, id, userID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
