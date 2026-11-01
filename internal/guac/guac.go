// Package guac speaks enough of the Guacamole protocol to bridge a browser
// client to guacd: framing, a reader that yields whole instructions, and an
// encoder. Element lengths count Unicode code points, not bytes.
package guac

import (
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxElement = 4 << 20 // longest element accepted, in code points
	maxPending = 8 << 20 // longest unfinished instruction buffered, in bytes
)

var (
	ErrIncomplete = errors.New("guac: incomplete instruction")
	ErrMalformed  = errors.New("guac: malformed instruction")
)

type Instruction struct {
	Opcode string
	Args   []string
}

func Encode(opcode string, args ...string) string {
	var b strings.Builder
	element(&b, opcode)
	for _, a := range args {
		b.WriteByte(',')
		element(&b, a)
	}
	b.WriteByte(';')
	return b.String()
}

func element(b *strings.Builder, s string) {
	b.WriteString(strconv.Itoa(utf8.RuneCountInString(s)))
	b.WriteByte('.')
	b.WriteString(s)
}

// Parse reads one instruction from the start of data and returns how many
// bytes it used. It returns ErrIncomplete if data ends mid-instruction.
func Parse(data []byte) (Instruction, int, error) {
	var elems []string
	i := 0
	for {
		start := i
		for i < len(data) && data[i] >= '0' && data[i] <= '9' {
			i++
		}
		if i >= len(data) {
			return Instruction{}, 0, ErrIncomplete
		}
		if data[i] != '.' || i == start || i-start > 8 {
			return Instruction{}, 0, ErrMalformed
		}
		n, _ := strconv.Atoi(string(data[start:i]))
		if n > maxElement {
			return Instruction{}, 0, ErrMalformed
		}
		i++
		valStart := i
		for k := 0; k < n; k++ {
			if !utf8.FullRune(data[min(i, len(data)):]) {
				return Instruction{}, 0, ErrIncomplete
			}
			_, size := utf8.DecodeRune(data[i:])
			i += size
		}
		elems = append(elems, string(data[valStart:i]))
		if i >= len(data) {
			return Instruction{}, 0, ErrIncomplete
		}
		switch data[i] {
		case ',':
			i++
		case ';':
			return Instruction{Opcode: elems[0], Args: elems[1:]}, i + 1, nil
		default:
			return Instruction{}, 0, ErrMalformed
		}
	}
}

// Reader turns a byte stream into whole instructions.
type Reader struct {
	r       io.Reader
	buf     []byte
	pending []parsed
}

type parsed struct {
	ins Instruction
	raw []byte
}

func NewReader(r io.Reader) *Reader { return &Reader{r: r} }

// fill reads until at least one more instruction is buffered.
func (rd *Reader) fill() error {
	tmp := make([]byte, 32*1024)
	for len(rd.pending) == 0 {
		for len(rd.buf) > 0 {
			ins, n, err := Parse(rd.buf)
			if errors.Is(err, ErrIncomplete) {
				break
			}
			if err != nil {
				return err
			}
			rd.pending = append(rd.pending, parsed{ins, append([]byte(nil), rd.buf[:n]...)})
			rd.buf = rd.buf[n:]
		}
		if len(rd.pending) > 0 {
			return nil
		}
		if len(rd.buf) > maxPending {
			return ErrMalformed
		}
		n, err := rd.r.Read(tmp)
		rd.buf = append(rd.buf, tmp[:n]...)
		if err != nil && n == 0 {
			return err
		}
	}
	return nil
}

// Next returns the next instruction.
func (rd *Reader) Next() (Instruction, error) {
	if err := rd.fill(); err != nil {
		return Instruction{}, err
	}
	p := rd.pending[0]
	rd.pending = rd.pending[1:]
	return p.ins, nil
}

// Batch returns every complete instruction available now as one run of bytes,
// blocking until there is at least one.
func (rd *Reader) Batch() ([]byte, error) {
	if err := rd.fill(); err != nil {
		return nil, err
	}
	var out []byte
	for _, p := range rd.pending {
		out = append(out, p.raw...)
	}
	rd.pending = nil
	return out, nil
}
