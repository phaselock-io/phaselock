package main

// A small msgpack codec for the auth endpoint, frame headers, and tests.
// Values are the JSON projection, nil, bool, int64, float64, string,
// []byte, []any, map[string]any, plus time.Time as the timestamp
// extension.

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"time"
)

func mpEncode(v any) []byte {
	var b []byte
	return mpAppend(b, v)
}

func mpAppend(b []byte, v any) []byte {
	switch x := v.(type) {
	case nil:
		return append(b, 0xc0)
	case bool:
		if x {
			return append(b, 0xc3)
		}
		return append(b, 0xc2)
	case int:
		return mpAppendInt(b, int64(x))
	case int64:
		return mpAppendInt(b, x)
	case uint64:
		if x <= math.MaxInt64 {
			return mpAppendInt(b, int64(x))
		}
		return binary.BigEndian.AppendUint64(append(b, 0xcf), x)
	case float64:
		return binary.BigEndian.AppendUint64(append(b, 0xcb), math.Float64bits(x))
	case time.Time:
		return mpAppendTime(b, x)
	case string:
		return mpAppendStr(b, x)
	case []byte:
		switch {
		case len(x) < 256:
			b = append(b, 0xc4, byte(len(x)))
		case len(x) < 65536:
			b = binary.BigEndian.AppendUint16(append(b, 0xc5), uint16(len(x)))
		default:
			b = binary.BigEndian.AppendUint32(append(b, 0xc6), uint32(len(x)))
		}
		return append(b, x...)
	case []string:
		b = mpArrayHeader(b, len(x))
		for _, s := range x {
			b = mpAppendStr(b, s)
		}
		return b
	case []any:
		b = mpArrayHeader(b, len(x))
		for _, e := range x {
			b = mpAppend(b, e)
		}
		return b
	case map[string]any:
		b = mpMapHeader(b, len(x))
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b = mpAppendStr(b, k)
			b = mpAppend(b, x[k])
		}
		return b
	}
	panic(fmt.Sprintf("mpEncode: unsupported type %T", v))
}

func mpAppendInt(b []byte, x int64) []byte {
	switch {
	case x >= 0 && x < 128:
		return append(b, byte(x))
	case x < 0 && x >= -32:
		return append(b, byte(x))
	case x >= 0 && x < 256:
		return append(b, 0xcc, byte(x))
	case x >= 0 && x < 65536:
		return binary.BigEndian.AppendUint16(append(b, 0xcd), uint16(x))
	case x >= 0 && x < 1<<32:
		return binary.BigEndian.AppendUint32(append(b, 0xce), uint32(x))
	case x >= 0:
		return binary.BigEndian.AppendUint64(append(b, 0xcf), uint64(x))
	case x >= -128:
		return append(b, 0xd0, byte(x))
	case x >= -32768:
		return binary.BigEndian.AppendUint16(append(b, 0xd1), uint16(x))
	case x >= math.MinInt32:
		return binary.BigEndian.AppendUint32(append(b, 0xd2), uint32(x))
	default:
		return binary.BigEndian.AppendUint64(append(b, 0xd3), uint64(x))
	}
}

// mpAppendTime writes the smallest timestamp extension that holds the
// time, at millisecond precision.
func mpAppendTime(b []byte, t time.Time) []byte {
	ms := t.UnixMilli()
	sec := ms / 1000
	if ms%1000 < 0 {
		sec--
	}
	nsec := uint32((ms - sec*1000) * 1e6)
	switch {
	case sec >= 0 && sec <= math.MaxUint32 && nsec == 0:
		return binary.BigEndian.AppendUint32(append(b, 0xd6, 0xff), uint32(sec))
	case sec >= 0 && sec < 1<<34:
		b = append(b, 0xd7, 0xff)
		b = binary.BigEndian.AppendUint32(b, nsec<<2|uint32(sec>>32))
		return binary.BigEndian.AppendUint32(b, uint32(sec))
	default:
		b = append(b, 0xc7, 12, 0xff)
		b = binary.BigEndian.AppendUint32(b, nsec)
		return binary.BigEndian.AppendUint64(b, uint64(sec))
	}
}

func mpAppendStr(b []byte, s string) []byte {
	switch {
	case len(s) < 32:
		b = append(b, 0xa0|byte(len(s)))
	case len(s) < 256:
		b = append(b, 0xd9, byte(len(s)))
	case len(s) < 65536:
		b = binary.BigEndian.AppendUint16(append(b, 0xda), uint16(len(s)))
	default:
		b = binary.BigEndian.AppendUint32(append(b, 0xdb), uint32(len(s)))
	}
	return append(b, s...)
}

func mpArrayHeader(b []byte, n int) []byte {
	switch {
	case n < 16:
		return append(b, 0x90|byte(n))
	case n < 65536:
		return binary.BigEndian.AppendUint16(append(b, 0xdc), uint16(n))
	default:
		return binary.BigEndian.AppendUint32(append(b, 0xdd), uint32(n))
	}
}

func mpMapHeader(b []byte, n int) []byte {
	switch {
	case n < 16:
		return append(b, 0x80|byte(n))
	case n < 65536:
		return binary.BigEndian.AppendUint16(append(b, 0xde), uint16(n))
	default:
		return binary.BigEndian.AppendUint32(append(b, 0xdf), uint32(n))
	}
}

type mpDecoder struct {
	r *bufio.Reader
}

func newMpDecoder(r io.Reader) *mpDecoder {
	return &mpDecoder{r: bufio.NewReader(r)}
}

var errMpType = errors.New("msgpack: unsupported type")

func (d *mpDecoder) Decode() (any, error) {
	c, err := d.r.ReadByte()
	if err != nil {
		return nil, err
	}
	switch {
	case c <= 0x7f:
		return int64(c), nil
	case c >= 0xe0:
		return int64(int8(c)), nil
	case c&0xf0 == 0x80:
		return d.mapN(int(c & 0x0f))
	case c&0xf0 == 0x90:
		return d.arrayN(int(c & 0x0f))
	case c&0xe0 == 0xa0:
		return d.str(int(c & 0x1f))
	}
	switch c {
	case 0xc0:
		return nil, nil
	case 0xc2:
		return false, nil
	case 0xc3:
		return true, nil
	case 0xc4, 0xc5, 0xc6:
		n, err := d.length(c - 0xc4)
		if err != nil {
			return nil, err
		}
		b := make([]byte, n)
		_, err = io.ReadFull(d.r, b)
		return b, err
	case 0xca:
		var u uint32
		if err := d.readBE(&u); err != nil {
			return nil, err
		}
		return float64(math.Float32frombits(u)), nil
	case 0xcb:
		var u uint64
		if err := d.readBE(&u); err != nil {
			return nil, err
		}
		return math.Float64frombits(u), nil
	case 0xcc:
		var u uint8
		err := d.readBE(&u)
		return int64(u), err
	case 0xcd:
		var u uint16
		err := d.readBE(&u)
		return int64(u), err
	case 0xce:
		var u uint32
		err := d.readBE(&u)
		return int64(u), err
	case 0xcf:
		var u uint64
		err := d.readBE(&u)
		if u > math.MaxInt64 {
			return u, err
		}
		return int64(u), err
	case 0xd0:
		var i int8
		err := d.readBE(&i)
		return int64(i), err
	case 0xd1:
		var i int16
		err := d.readBE(&i)
		return int64(i), err
	case 0xd2:
		var i int32
		err := d.readBE(&i)
		return int64(i), err
	case 0xd3:
		var i int64
		err := d.readBE(&i)
		return i, err
	case 0xd9, 0xda, 0xdb:
		n, err := d.length(c - 0xd9)
		if err != nil {
			return nil, err
		}
		return d.str(n)
	case 0xd6, 0xd7, 0xc7:
		return d.timestamp(c)
	case 0xdc, 0xdd:
		n, err := d.length(c - 0xdc + 1)
		if err != nil {
			return nil, err
		}
		return d.arrayN(n)
	case 0xde, 0xdf:
		n, err := d.length(c - 0xde + 1)
		if err != nil {
			return nil, err
		}
		return d.mapN(n)
	}
	return nil, fmt.Errorf("%w: 0x%02x", errMpType, c)
}

// timestamp reads the rest of a timestamp extension whose first byte was
// c, in any of its three sizes.
func (d *mpDecoder) timestamp(c byte) (any, error) {
	var sec int64
	var nsec uint32
	switch c {
	case 0xd6:
		var hdr [1]byte
		var u uint32
		if _, err := io.ReadFull(d.r, hdr[:]); err != nil {
			return nil, err
		}
		if hdr[0] != 0xff {
			return nil, fmt.Errorf("%w: ext %d", errMpType, int8(hdr[0]))
		}
		if err := d.readBE(&u); err != nil {
			return nil, err
		}
		sec = int64(u)
	case 0xd7:
		var hdr [1]byte
		var hi, lo uint32
		if _, err := io.ReadFull(d.r, hdr[:]); err != nil {
			return nil, err
		}
		if hdr[0] != 0xff {
			return nil, fmt.Errorf("%w: ext %d", errMpType, int8(hdr[0]))
		}
		if err := d.readBE(&hi); err != nil {
			return nil, err
		}
		if err := d.readBE(&lo); err != nil {
			return nil, err
		}
		sec = int64(hi&0x3)<<32 | int64(lo)
		nsec = hi >> 2
	default:
		var hdr [2]byte
		if _, err := io.ReadFull(d.r, hdr[:]); err != nil {
			return nil, err
		}
		if hdr[0] != 12 || hdr[1] != 0xff {
			return nil, fmt.Errorf("%w: ext8 of %d bytes, type %d", errMpType, hdr[0], int8(hdr[1]))
		}
		if err := d.readBE(&nsec); err != nil {
			return nil, err
		}
		if err := d.readBE(&sec); err != nil {
			return nil, err
		}
	}
	return time.Unix(sec, int64(nsec)).UTC(), nil
}

func (d *mpDecoder) readBE(v any) error {
	return binary.Read(d.r, binary.BigEndian, v)
}

// length reads a 1, 2, or 4 byte big-endian length selected by width 0..2
func (d *mpDecoder) length(width byte) (int, error) {
	switch width {
	case 0:
		var n uint8
		err := d.readBE(&n)
		return int(n), err
	case 1:
		var n uint16
		err := d.readBE(&n)
		return int(n), err
	default:
		var n uint32
		err := d.readBE(&n)
		return int(n), err
	}
}

func (d *mpDecoder) str(n int) (any, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(d.r, b); err != nil {
		return nil, err
	}
	return string(b), nil
}

func (d *mpDecoder) arrayN(n int) (any, error) {
	out := make([]any, 0, n)
	for i := 0; i < n; i++ {
		v, err := d.Decode()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (d *mpDecoder) mapN(n int) (any, error) {
	out := make(map[string]any, n)
	for i := 0; i < n; i++ {
		k, err := d.Decode()
		if err != nil {
			return nil, err
		}
		ks, ok := k.(string)
		if !ok {
			return nil, errors.New("msgpack: map key is not a string")
		}
		v, err := d.Decode()
		if err != nil {
			return nil, err
		}
		out[ks] = v
	}
	return out, nil
}

func mpDecodeBytes(b []byte) (any, error) {
	return newMpDecoder(bytesReader(b)).Decode()
}
