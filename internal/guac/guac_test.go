package guac

import (
	"bytes"
	"errors"
	"io"
	"testing"
	"testing/iotest"
)

func TestEncodeCountsCodePoints(t *testing.T) {
	got := Encode("clipboard", "é語🙂")
	if got != "9.clipboard,3.é語🙂;" {
		t.Fatalf("got %q", got)
	}
	ins, n, err := Parse([]byte(got))
	if err != nil || n != len(got) || ins.Opcode != "clipboard" || len(ins.Args) != 1 || ins.Args[0] != "é語🙂" {
		t.Fatalf("round trip: %+v %d %v", ins, n, err)
	}
}

func TestParse(t *testing.T) {
	ins, n, err := Parse([]byte("5.mouse,2.10,3.200,1.0;4.sync"))
	if err != nil || n != 23 || ins.Opcode != "mouse" || len(ins.Args) != 3 || ins.Args[1] != "200" {
		t.Fatalf("%+v %d %v", ins, n, err)
	}
	// Elements may be empty; an empty opcode is how internal frames look.
	ins, _, err = Parse([]byte("0.,4.ping,1.5;"))
	if err != nil || ins.Opcode != "" || ins.Args[0] != "ping" {
		t.Fatalf("internal frame: %+v %v", ins, err)
	}
	for _, in := range []string{"5.mou", "5.mouse,", "5.mouse,2.1", "3.é"} {
		if _, _, err := Parse([]byte(in)); !errors.Is(err, ErrIncomplete) {
			t.Errorf("%q: want incomplete, got %v", in, err)
		}
	}
	for _, in := range []string{"x.mouse;", ".mouse;", "5.mouseX", "99999999999.a;", "5.mouse|"} {
		if _, _, err := Parse([]byte(in)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%q: want malformed, got %v", in, err)
		}
	}
}

func TestReaderHandlesFragmentation(t *testing.T) {
	stream := Encode("args", "VERSION_1_5_0", "hostname") + Encode("clipboard", "日本語テキスト") + Encode("sync", "42")
	// One byte at a time: instructions (and multi-byte characters) split across reads.
	rd := NewReader(iotest.OneByteReader(bytes.NewReader([]byte(stream))))
	for _, want := range []string{"args", "clipboard", "sync"} {
		ins, err := rd.Next()
		if err != nil || ins.Opcode != want {
			t.Fatalf("want %s, got %+v %v", want, ins, err)
		}
	}
	if _, err := rd.Next(); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestBatchReturnsWholeInstructionsOnly(t *testing.T) {
	a, b := Encode("sync", "1"), Encode("blob", "3", "aGk=")
	pr, pw := io.Pipe()
	rd := NewReader(pr)
	go func() {
		pw.Write([]byte(a + b[:5])) // second instruction is cut short
		pw.Write([]byte(b[5:]))
		pw.Close()
	}()
	first, err := rd.Batch()
	if err != nil || string(first) != a {
		t.Fatalf("first batch: %q %v", first, err)
	}
	second, err := rd.Batch()
	if err != nil || string(second) != b {
		t.Fatalf("second batch: %q %v", second, err)
	}
}

func TestReaderRejectsGarbage(t *testing.T) {
	rd := NewReader(bytes.NewReader([]byte("not guacamole")))
	if _, err := rd.Next(); err == nil {
		t.Fatal("garbage accepted")
	}
}
