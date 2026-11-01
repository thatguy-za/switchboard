package store

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

var (
	ErrExists    = errors.New("already exists")
	ErrSetupDone = errors.New("setup already completed")
	ErrNotFound  = errors.New("not found")
)

type Store struct{ db *sql.DB }

type User struct {
	ID, Username, Role, PWHash                 string
	KEKSalt, WrappedVK, RecoveryVK, TOTPSecret []byte
	MustChange, TOTPEnabled                    bool
	TOTPStep, LockedUntil, CreatedAt           int64
	Failed                                     int
}

func Open(path string) (*Store, error) {
	dsn := path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return err
	}
	var current int
	err := s.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current)
	if err != nil {
		return err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var v int
		if _, err := fmt.Sscanf(name, "%d_", &v); err != nil || v <= current {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, v); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

const userCols = `id, username, role, pw_hash, kek_salt, wrapped_vk, recovery_vk, must_change,
	totp_secret, totp_enabled, totp_step, failed, locked_until, created_at`

type scanner interface{ Scan(...any) error }

func scanUser(r scanner) (*User, error) {
	var u User
	err := r.Scan(&u.ID, &u.Username, &u.Role, &u.PWHash, &u.KEKSalt, &u.WrappedVK, &u.RecoveryVK,
		&u.MustChange, &u.TOTPSecret, &u.TOTPEnabled, &u.TOTPStep, &u.Failed, &u.LockedUntil, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &u, err
}

type execer interface {
	Exec(string, ...any) (sql.Result, error)
}

func insertUser(e execer, u *User) error {
	if u.CreatedAt == 0 {
		u.CreatedAt = time.Now().Unix()
	}
	_, err := e.Exec(`INSERT INTO users (`+userCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		u.ID, u.Username, u.Role, u.PWHash, u.KEKSalt, u.WrappedVK, u.RecoveryVK, u.MustChange,
		u.TOTPSecret, u.TOTPEnabled, u.TOTPStep, u.Failed, u.LockedUntil, u.CreatedAt)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrExists
	}
	return err
}

func (s *Store) CreateUser(u *User) error { return insertUser(s.db, u) }

// CreateOwner inserts the first user and fails if any user exists.
func (s *Store) CreateOwner(u *User) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrSetupDone
	}
	if err := insertUser(tx, u); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) UserCount() (n int, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return
}

func (s *Store) AdminCount() (n int, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&n)
	return
}

func (s *Store) UserByName(name string) (*User, error) {
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE username = ?`, name))
}

func (s *Store) UserByID(id string) (*User, error) {
	return scanUser(s.db.QueryRow(`SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

func (s *Store) ListUsers() ([]*User, error) {
	rows, err := s.db.Query(`SELECT ` + userCols + ` FROM users ORDER BY created_at, username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) DeleteUser(id string) error {
	res, err := s.db.Exec(`DELETE FROM users WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetCredentials(id, pwHash string, salt, wrappedVK, recoveryVK []byte, mustChange bool) error {
	_, err := s.db.Exec(`UPDATE users SET pw_hash=?, kek_salt=?, wrapped_vk=?, recovery_vk=?, must_change=?,
		failed=0, locked_until=0 WHERE id=?`, pwHash, salt, wrappedVK, recoveryVK, mustChange, id)
	return err
}

func (s *Store) SetTOTP(id string, sealedSecret []byte, enabled bool, step int64) error {
	_, err := s.db.Exec(`UPDATE users SET totp_secret=?, totp_enabled=?, totp_step=? WHERE id=?`,
		sealedSecret, enabled, step, id)
	return err
}

func (s *Store) SetTOTPStep(id string, step int64) error {
	_, err := s.db.Exec(`UPDATE users SET totp_step=? WHERE id=?`, step, id)
	return err
}

func (s *Store) ClearTOTP(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET totp_secret=NULL, totp_enabled=0, totp_step=0 WHERE id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM backup_codes WHERE user_id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// RecordFailure counts a failed attempt and locks the account until lockUntil
// once max failures accumulate. It reports whether the account is now locked.
func (s *Store) RecordFailure(id string, max int, lockUntil int64) (locked bool, err error) {
	_, err = s.db.Exec(`UPDATE users SET
		locked_until = CASE WHEN failed + 1 >= ? THEN ? ELSE locked_until END,
		failed = CASE WHEN failed + 1 >= ? THEN 0 ELSE failed + 1 END
		WHERE id = ?`, max, lockUntil, max, id)
	if err != nil {
		return false, err
	}
	var until int64
	err = s.db.QueryRow(`SELECT locked_until FROM users WHERE id=?`, id).Scan(&until)
	return until >= lockUntil, err
}

func (s *Store) ResetFailures(id string) error {
	_, err := s.db.Exec(`UPDATE users SET failed=0, locked_until=0 WHERE id=?`, id)
	return err
}

func (s *Store) ReplaceBackupCodes(id string, hashes [][]byte) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM backup_codes WHERE user_id=?`, id); err != nil {
		return err
	}
	for _, h := range hashes {
		if _, err := tx.Exec(`INSERT INTO backup_codes (user_id, hash) VALUES (?, ?)`, id, h); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) UseBackupCode(id string, hash []byte) (bool, error) {
	res, err := s.db.Exec(`UPDATE backup_codes SET used=1 WHERE rowid = (
		SELECT rowid FROM backup_codes WHERE user_id=? AND hash=? AND used=0 LIMIT 1)`, id, hash)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func (s *Store) BackupCodesLeft(id string) (n int, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*) FROM backup_codes WHERE user_id=? AND used=0`, id).Scan(&n)
	return
}

func (s *Store) Setting(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}
