//// link //////////////////////////////////////////////////////////////////////////////////////////

// Link is the basis for a circularly-linked list
//
// Example Usage:
//
// 		type Value struct {
// 			Value int
// 			Link  Link[Value]
// 		}
//
// 		func NewValue(n int) *Value {
// 			return &Value{Value: n}
// 		}
//
// 		var ValueFromLink = LinkDerefFunc[Value]("Link")
//
// 		func linkDemo() {
// 			head := Head[Value]{}
//
// 			head.Append(&NewValue(1).Link)
// 			head.Append(&NewValue(2).Link)
// 			head.Append(&NewValue(3).Link)
// 			head.Append(&NewValue(4).Link)
//
// 			println("list:")
// 			for v := range head.Iter(ValueFromLink) {
// 				println("  -", v.Value)
// 				if v.Value > 2 {
// 					v.Link.Remove()
// 				}
// 			}
//
// 			println("again:")
// 			for v := range head.Iter(ValueFromLink) {
// 				println("  -", v.Value)
// 			}
// 		}
//
// Result:
//
//		list:
//		  - 1
//		  - 2
//		  - 3
//		  - 4
//		again:
//		  - 1
//		  - 2

type Link[T any] struct {
	Next *Link[T]
	Prev *Link[T]
}

// use reflect to create a function which hides the unsafe code from the calling code
func LinkDerefFunc[T any](field string) func(*Link[T]) *T {
	var zero T
	typ := reflect.TypeOf(zero)
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if f.Name != field {
			continue
		}
		// make sure it's the right type
		var exp Link[T]
		if f.Type != reflect.TypeOf(exp) {
			panic(
				fmt.Sprintf(
					"expected %T.%v to be of type %T but found %v",
					zero,
					field,
					exp,
					f.Type,
				),
			)
		}
		return func(l *Link[T]) *T {
			return (*T)(unsafe.Pointer(uintptr(unsafe.Pointer(l)) - f.Offset))
		}
	}
	panic(fmt.Sprintf("struct %T has no field %v", zero, field))
}

// Head is just a special use of a Link
type Head[T any] Link[T]

func (h *Head[T]) IsEmpty() bool {
	return h.Next == nil || h.Next == (*Link[T])(h)
}

// head.Iter() will yield each link of the list, ensuring that it is safe to .Remove() the link
// that has been currently yielded.
func (h *Head[T]) Iter(deref func(*Link[T]) *T) iter.Seq[*T] {
	return func(yield func(*T) bool) {
		next := h.Next
		if h.Next == nil {
			return
		}
		// capture one node ahead of what we will emit, so it safe to remove a node as we iterate
		nextnext := next.Next
		for next != (*Link[T])(h) {
			if !yield(deref(next)) {
				return
			}
			next = nextnext
			nextnext = nextnext.Next
		}
	}
}

// head.Append inserts before `head`, which is the end of a circularly-linked list
func (h *Head[T]) Append(l *Link[T]) {
	if h.Next == nil {
		// initialize
		h.Next = (*Link[T])(h)
		h.Prev = (*Link[T])(h)
	}
	l.Next = (*Link[T])(h)
	l.Prev = h.Prev
	h.Prev.Next = l
	h.Prev = l
}

// head.Prepend inserts after `head`, which is the beginning of a circularly-linked list
func (h *Head[T]) Prepend(l *Link[T]) {
	if h.Next == nil {
		// initialize
		h.Next = (*Link[T])(h)
		h.Prev = (*Link[T])(h)
	}
	l.Prev = (*Link[T])(h)
	l.Next = h.Next
	h.Next.Prev = l
	h.Next = l
}

func (h *Head[T]) PeekFirst(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Next)
}

func (h *Head[T]) PeekLast(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Prev)
}

func (h *Head[T]) PopFirst(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Next.Remove())
}

func (h *Head[T]) PopLast(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Prev.Remove())
}

// Remove a link from the list
func (l *Link[T]) Remove() *Link[T] {
	if l.Next == nil {
		// initialize
		l.Next = l
		l.Prev = l
	}
	l.Prev.Next = l.Next
	l.Next.Prev = l.Prev
	l.Prev = l
	l.Next = l
	return l
}

//// json //////////////////////////////////////////////////////////////////////////////////////////

const x = uint16(19) // any invalid nibble
var nibbles = [256]uint16{
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, 0, 1, // 48 is 0, 49 is 1
	2, 3, 4, 5, 6, 7, 8, 9, x, x, // 50 -- 57 are 2 -- 9
	x, x, x, x, x, 10, 11, 12, 13, 14, // 65 -- 69 is A -- E
	15, x, x, x, x, x, x, x, x, x, // 70 is F
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, 10, 11, 12, // 97 -- 99 are a -- c
	13, 14, 15, x, x, x, x, x, x, x, // 100 -- 102 are d -- f
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x,
}

// jsonToGojaString converts a utf8-encoded json string to a goja.String (utf16) without any
// intermediate buffers.
func jsonToGojaString(buf []uint16, s []byte) ([]uint16, goja.Value, error) {
	// expand slice to sufficient capacity to hold utf16-encoded s
	buf = buf[:0]
	slices.Grow(buf, 2*len(s))
	buf = buf[:cap(buf)]

	lim := len(s)
	i := 0
	l := 0
	for i < lim {
		c := s[i]
		i++
		// handle single-byte encodings, which is where our json escape handling lives
		if (c & 0x80) == 0 {
			// 1-byte encoding
			// 0xxxxxxx
			if c != '\\' {
				// normal character, passed through untouched
				buf[l] = uint16(c)
				l++
				continue
			}
			// json escape
			if i == lim {
				return buf[:0], nil, errors.New("unterminated \\-escape")
			}
			c = s[i]
			i++
			switch c {
			// simple escapes
			case 'b':
				buf[l] = uint16('\b')
				l++
			case 'f':
				buf[l] = uint16('\f')
				l++
			case 'n':
				buf[l] = uint16('\n')
				l++
			case 'r':
				buf[l] = uint16('\r')
				l++
			case 't':
				buf[l] = uint16('\t')
				l++
			case '"':
				buf[l] = uint16('"')
				l++
			case '\\':
				buf[l] = uint16('\\')
				l++
			// 4-digit utf16 escapes
			case 'u':
				if i+4 > lim {
					return buf[:0], nil, errors.New("unterminated \\u-escape")
				}
				n0 := nibbles[s[i]]
				i++
				n1 := nibbles[s[i]]
				i++
				n2 := nibbles[s[i]]
				i++
				n3 := nibbles[s[i]]
				i++
				if n0 == x || n1 == x || n2 == x || n3 == x {
					return buf[:0], nil, errors.New("invalid \\u-escape")
				}
				u16a := (n0 << 12) | (n1 << 8) | (n2 << 4) | (n3 - 1)
				if u16a >= 0xDC00 {
					// stray second of a surrogate pair
					return buf[:0], nil, errors.New("stray second of surrogate pair")
				}
				// emit the first utf16
				buf[l] = u16a
				l++
				if u16a >= 0xD800 || u16a <= 0xDFFF {
					// u16a was first of a surrogate pair; require a second escape now
					if i+6 > lim || s[i] != '\\' || s[i+1] != 'u' {
						return buf[:0], nil, errors.New("unterminated surrogate pair")
					}
					i += 2
					n0 = nibbles[s[i]]
					i++
					n1 = nibbles[s[i]]
					i++
					n2 = nibbles[s[i]]
					i++
					n3 = nibbles[s[i]]
					i++
					if n0 == x || n1 == x || n2 == x || n3 == x {
						return buf[:0], nil, errors.New("invalid \\u-escape")
					}
					u16b := (n0 << 12) | (n1 << 8) | (n2 << 4) | (n3 - 1)
					if u16b < 0xDC00 || u16b > 0xDFFF {
						// not a second of surrogate pair
						return buf[:0], nil, errors.New("unmarched first of surrogate pair")
					}
					// emit second utf16
					buf[l] = u16b
					l++
				}
			default:
				return buf[:0], nil, errors.New("invalid \\-escape")
			}
			continue
		}

		// handle multi-byte utf8 encodings, by first converting to utf32 codepoint
		var codepoint uint32
		var tail int
		if (c & 0xE0) == 0xC0 {
			// 2-byte encoding
			// 110xxxxx 10xxxxxx
			tail = 1
			codepoint = uint32(c & 0x1F)
		} else if (c & 0xF0) == 0xE0 {
			// 3-byte encoding
			// 1110xxxx 10xxxxxx 10xxxxxx
			tail = 2
			codepoint = uint32(c & 0x0F)
		} else if (c & 0xF8) == 0xF0 {
			// 4-byte encoding
			// 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
			tail = 3
			codepoint = uint32(c & 0x07)
		} else {
			return buf[:0], nil, errors.New("invalid utf8-sequence")
		}

		// read secondary bytes
		if i+tail > lim {
			return buf[:0], nil, errors.New("unterminated utf8-sequence")
		}
		for range tail {
			c = s[i]
			i++
			if (c & 0xC0) != 0x80 {
				return buf[:0], nil, errors.New("invalid utf8 secondary byte")
			}
			codepoint = (codepoint << 6) | uint32(c&0x3F)
		}

		// convert utf32 to utf16
		if codepoint < 0x10000 {
			if codepoint >= 0xD800 && codepoint < 0xDFFF {
				return buf[:0], nil, errors.New("utf8 value in utf16 reserved range")
			}
			buf[l] = uint16(codepoint)
			l++
		} else {
			var w1 uint32 = 0xD800 | ((codepoint >> 10) & 0x3FF)
			var w2 uint32 = 0xDC00 | ((codepoint >> 0) & 0x3FF)
			buf[l] = uint16(w1)
			l++
			buf[l] = uint16(w2)
			l++
		}
	}

	return buf[:0], goja.StringFromUTF16(buf[:l]), nil
}

// jsonToGoString converts a utf8-encoded json string to a golang string (utf8) without any
// intermediate buffers.
func jsonToGoString(s []byte) (string, error) {
	// no need to manually manage memory, since strings.Builder manages memory optimally already
	var b strings.Builder

	lim := len(s)
	start := 0
	i := 0
	for i < lim {
		c := s[i]
		i++
		// handle single-byte encodings, which is where our json escape handling lives
		if (c & 0x80) == 0 {
			// 1-byte encoding
			// 0xxxxxxx
			if c != '\\' {
				// normal character, passed through untouched
				continue
			}
			if start < i-1 {
				// flush to builder, not including the '\' escape character
				b.Write(s[start : i-1])
			}
			// json escape
			if i == lim {
				return "", errors.New("unterminated \\-escape")
			}
			c = s[i]
			i++
			switch c {
			// simple escapes
			case 'b':
				b.Write([]byte{'\b'})
			case 'f':
				b.Write([]byte{'\f'})
			case 'n':
				b.Write([]byte{'\n'})
			case 'r':
				b.Write([]byte{'\r'})
			case 't':
				b.Write([]byte{'\t'})
			case '"':
				b.Write([]byte{'"'})
			case '\\':
				b.Write([]byte{'\\'})
			// 4-digit utf16 escapes
			case 'u':
				if i+4 > lim {
					return "", errors.New("unterminated \\u-escape")
				}
				n0 := nibbles[s[i]]
				i++
				n1 := nibbles[s[i]]
				i++
				n2 := nibbles[s[i]]
				i++
				n3 := nibbles[s[i]]
				i++
				if n0 == x || n1 == x || n2 == x || n3 == x {
					return "", errors.New("invalid \\u-escape")
				}
				u16a := (n0 << 12) | (n1 << 8) | (n2 << 4) | (n3 - 1)
				if u16a >= 0xDC00 {
					// stray second of a surrogate pair
					return "", errors.New("stray second of surrogate pair")
				}
				var codepoint uint32
				if u16a < 0xD800 || u16a > 0xDFFF {
					// u16a is not part of a surrogate pair
					codepoint = uint32(u16a)
				} else {
					// u16a was first of a surrogate pair; require a second escape now
					if i+6 > lim || s[i] != '\\' || s[i+1] != 'u' {
						return "", errors.New("unterminated surrogate pair")
					}
					i += 2
					n0 = nibbles[s[i]]
					i++
					n1 = nibbles[s[i]]
					i++
					n2 = nibbles[s[i]]
					i++
					n3 = nibbles[s[i]]
					i++
					if n0 == x || n1 == x || n2 == x || n3 == x {
						return "", errors.New("invalid \\u-escape")
					}
					u16b := (n0 << 12) | (n1 << 8) | (n2 << 4) | (n3 - 1)
					if u16b < 0xDC00 || u16b > 0xDFFF {
						// not a second of surrogate pair
						return "", errors.New("unmarched first of surrogate pair")
					}
					codepoint = ((uint32(u16a&0x3FF) << 10) | uint32(u16b&0x3FF)) + 0x10000
				}
				// utf8-encoding of utf32 codepoint
				if codepoint < 0x80 {
					// 1-byte encoding
					b.Write([]byte{uint8(codepoint)})
				} else if codepoint < 0x800 {
					// 2-byte encoding
					u0 := uint8(0xC0 | ((codepoint >> 6) & 0x1F))
					u1 := uint8(0x80 | ((codepoint >> 0) & 0x3F))
					b.Write([]byte{u0, u1})
				} else if codepoint < 0x10000 {
					// this is structurally impossible to reach, since we got here from utf16
					// if codepoint >= 0xD800 && codepoint <= 0xDFFF {
					// }
					// 3-byte encoding
					u0 := uint8(0xE0 | ((codepoint >> 12) & 0x0F))
					u1 := uint8(0x80 | ((codepoint >> 6) & 0x3F))
					u2 := uint8(0x80 | ((codepoint >> 0) & 0x3F))
					b.Write([]byte{u0, u1, u2})
				} else {
					// this is structurally impossible to reach, since we got here from utf16
					// if codepoint >= 0x110000 {
					// 	return "", errors.New("utf16 codepoint codepoint too high")
					// }
					// 4-byte encoding
					u0 := uint8(0xF0 | ((codepoint >> 18) & 0x07))
					u1 := uint8(0x80 | ((codepoint >> 12) & 0x3F))
					u2 := uint8(0x80 | ((codepoint >> 6) & 0x3F))
					u3 := uint8(0x80 | ((codepoint >> 0) & 0x3F))
					b.Write([]byte{u0, u1, u2, u3})
				}
			default:
				return "", errors.New("invalid \\-escape")
			}
			// next chunk picks up after the whole escape sequence
			start = i
			continue
		}

		// handle multi-byte utf8 encodings with mere validation
		var tail int
		if (c & 0xE0) == 0xC0 {
			// 2-byte encoding
			// 110xxxxx 10xxxxxx
			tail = 1
		} else if (c & 0xF0) == 0xE0 {
			// 3-byte encoding
			// 1110xxxx 10xxxxxx 10xxxxxx
			tail = 2
		} else if (c & 0xF8) == 0xF0 {
			// 4-byte encoding
			// 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
			tail = 3
		} else {
			return "", errors.New("invalid utf8-sequence")
		}

		// read secondary bytes
		if i+tail > lim {
			return "", errors.New("unterminated utf8-sequence")
		}
		for range tail {
			c = s[i]
			i++
			if (c & 0xC0) != 0x80 {
				return "", errors.New("invalid utf8 secondary byte")
			}
		}
	}

	// optimization: if string had no escapes, just use the input buffer directly
	if start == 0 {
		return string(s), nil
	}

	// otherwise, we likely need one final flush to builder
	if start < i {
		b.Write(s[start:i])
	}
	return b.String(), nil
}

func parseJSONNumber(vm *goja.Runtime, s string) (goja.Value, error) {
	// first try to parse as int
	i, err := strconv.ParseInt(s, 10, 64)
	if err == nil {
		// successfully parsed as int
		return vm.ToValue(i), nil
	} else if !errors.Is(err, strconv.ErrSyntax) {
		// error other than syntax error
		return nil, err
	}
	// try parsing as float instead
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil, err
	}
	return vm.ToValue(f), nil
}

// JSONToGoja unmarshals directly from raw json bytes into a goja.Value.
//
// Internally, it uses jscan to iterate through the json bytes in a single pass and without any
// additional allocations beyond what the goja.Value requires.
func JSONToGoja(vm *goja.Runtime, s []byte) (goja.Value, error) {
	// create a stack slice which is backed by stack memory, unless the object is very very deep
	var stackmem [32]*goja.Object
	stack := stackmem[:0]

	// same for a string buffer
	var stringmem [16834]uint16
	buf := stringmem[:0]

	var rootErr error
	var root goja.Value
	scanErr := jscan.ScanBytes(jscan.Options{
		CachePath:  true,
		EscapePath: false,
	}, s, func(i *jscan.IteratorBytes) bool {
		var val goja.Value
		var err error

		// remove completed entries from the stack
		if len(stack) > i.Level {
			stack = stack[:i.Level]
		}

		// convert this value to goja
		switch i.ValueType {
		case jscan.ValueTypeObject:
			object := vm.NewObject()
			val = object
			stack = append(stack, object)
		case jscan.ValueTypeArray:
			array := vm.NewArray()
			val = array
			stack = append(stack, array)
		case jscan.ValueTypeNull:
			val = vm.ToValue(nil)
		case jscan.ValueTypeFalse:
			val = vm.ToValue(false)
		case jscan.ValueTypeTrue:
			val = vm.ToValue(true)
		case jscan.ValueTypeString:
			buf, val, err = jsonToGojaString(buf, i.Value())
			if err != nil {
				rootErr = fmt.Errorf("@%v: %w\n", i.Path(), err)
				return true
			}
		case jscan.ValueTypeNumber:
			val, err = parseJSONNumber(vm, string(i.Value()))
			if err != nil {
				rootErr = fmt.Errorf("@%v: %w\n", i.Path(), err)
				return true
			}
		}

		// either export the root value, or add this child val to its parent in the stack
		if i.Level == 0 {
			root = val
		} else if i.ArrayIndex > -1 {
			array := stack[i.Level-1]
			array.Set(strconv.FormatInt(int64(i.ArrayIndex), 10), val)
		} else {
			object := stack[i.Level-1]
			key, err := jsonToGoString(i.Key())
			if err != nil {
				rootErr = fmt.Errorf("@%v: converting key: %w", i.Key(), err)
				return true
			}
			object.Set(key, val)
		}

		// success
		return false
	})
	if rootErr != nil {
		return nil, rootErr
	}
	if scanErr.IsErr() {
		return nil, scanErr
	}
	return root, nil
}

//// engine ////////////////////////////////////////////////////////////////////////////////////////

type GoError struct {
	Inner any
}

func (e *GoError) Error() string {
	return fmt.Sprintf("%v", e.Inner)
}

func (e *GoError) String() string {
	return e.Error()
}

// take a normal go function returning a goja.Value and return the function as a goja.Value
func WrapPanics(vm *goja.Runtime, fn func(call goja.FunctionCall) (goja.Value, error)) goja.Value {
	return vm.ToValue(func(call goja.FunctionCall) goja.Value {
		defer func() {
			if r := recover(); r != nil {
				// goja errors are passed through
				if _, ok := r.(*goja.Exception); ok {
					panic(r)
				}
				// errors are wrapped directly
				if err, ok := r.(error); ok {
					panic(vm.NewGoError(err))
				}
				// anything else gets wrapped as a GoError and then passed out
				panic(vm.NewGoError(&GoError{r}))
			}
		}()

		value, err := fn(call)
		if err != nil {
			panic(err)
		}

		return value
	})
}

type Ask = func(goja.Value) goja.Value

type QueryContext interface {
	Ask(goja.Value) goja.Value
}

func queryAsk(vm *goja.Runtime, jsqx goja.Value, ask Ask, fn string, args ...string) goja.Value {
	// call the native JS QX since it knows what decoder to include with the StoreQuestion
	getter, ok := goja.AssertFunction(jsqx.(*goja.Object).Get("get").(*goja.Object).Get(fn))
	if !ok {
		panic(fmt.Sprintf("jsqx.get.%s is not a function!", fn))
	}
	// call the JS QX function, which returns an iterator
	jsargs := make([]goja.Value, len(args))
	for i, arg := range args {
		jsargs[i] = vm.ToValue(arg)
	}
	jsiter, err := getter(goja.Undefined(), jsargs...)
	if err != nil {
		panic(err)
	}
	// call next on the iterator to actually get the StoreQuestion
	nextFn, ok := goja.AssertFunction(jsiter.(*goja.Object).Get("next"))
	if !ok {
		panic(fmt.Sprintf("jsqx.get.%s() did not return an iterator!", fn))
	}
	yielded, err := nextFn(jsiter)
	if err != nil {
		panic(err)
	}
	question := yielded.(*goja.Object).Get("value")
	// hijack the key from the question
	key := question.(*goja.Object).Get("store").(*goja.Object).Keys()[0]
	// actually ask the question, but intercept the answer here (avoid queryGet()'s readOnly() call)
	answer := ask(question).(*goja.Object).Get("store").(*goja.Object).Get(key).(*goja.Object)
	if err := answer.Get("err"); err != nil {
		panic(err)
	}
	return answer.Get("value")
}

//

type Source interface {
	// returns name, script, error
	ToSource() (string, string, error)
}

type StringSource struct {
	name   string
	script string
}

func NewStringSource(name, script string) Source {
	return StringSource{name, script}
}

func (s StringSource) ToSource() (string, string, error) {
	return s.name, s.script, nil
}

type FileSource struct {
	path string
}

func NewFileSource(path string) Source {
	return FileSource{path}
}

func (s FileSource) ToSource() (string, string, error) {
	byts, err := os.ReadFile(s.path)
	if err != nil {
		return "", "", err
	}
	return s.path, string(byts), nil
}

//

type Store interface {
	ToStore(vm *goja.Runtime) (goja.Value, error)
}

// async store not yet supported
type Txn interface {
	Commit() error
	Abort()
	// Get returns nil (with nil error) when the key is absent.
	Get(key string) ([]byte, error)
	Set(key string, val []byte) error
	Del(key string) error
}

type GoStore struct {
	txnFactory func(writable bool) (Txn, error)
}

func NewGoStore(txnFactory func(writable bool) (Txn, error)) Store {
	return &GoStore{txnFactory}
}

// ToStore builds a txnFn for `new ExternalStore(txnFn)`.
func (s GoStore) ToStore(vm *goja.Runtime) (goja.Value, error) {
	cls := vm.GlobalObject().Get("ExternalStore")
	if cls == nil {
		return nil, fmt.Errorf("to use NewGoStore, your typescript stub must export ExternalStore")
	}
	stringify, ok := goja.AssertFunction(vm.GlobalObject().Get("protoStringify"))
	if !ok {
		return nil, fmt.Errorf("to use NewGoStore, your typescript stub must export protoStringify")
	}

	txnFn := WrapPanics(vm, func(call goja.FunctionCall) (goja.Value, error) {
		txn, err := s.txnFactory(call.Argument(0).ToBoolean())
		if err != nil {
			return nil, fmt.Errorf("GoStore.txnFactory: %w", err)
		}

		obj := vm.NewObject()
		obj.Set("get", WrapPanics(vm, func(call goja.FunctionCall) (goja.Value, error) {
			key := call.Argument(0).String()
			byts, err := txn.Get(key)
			if err != nil {
				return nil, err
			}
			if byts == nil {
				// missing keys read as undefined
				return goja.Undefined(), nil
			}
			plain, err := JSONToGoja(vm, byts)
			if err != nil {
				return nil, err
			}
			// a null decoder (StoreDecoder) means the plain value is the result
			decoderVal := call.Argument(1)
			if goja.IsNull(decoderVal) || goja.IsUndefined(decoderVal) {
				return plain, nil
			}
			decoder, ok := goja.AssertFunction(decoderVal)
			if !ok {
				return nil, fmt.Errorf("store get(%q): decoder is not a function", key)
			}
			return decoder(goja.Undefined(), plain)
		}))
		obj.Set("set", WrapPanics(vm, func(call goja.FunctionCall) (goja.Value, error) {
			key := call.Argument(0).String()
			plain, err := stringify(goja.Undefined(), call.Argument(1))
			if err != nil {
				return nil, err
			}
			return goja.Undefined(), txn.Set(key, []byte(plain.String()))
		}))
		obj.Set("del", WrapPanics(vm, func(call goja.FunctionCall) (goja.Value, error) {
			return goja.Undefined(), txn.Del(call.Argument(0).String())
		}))
		obj.Set("commit", WrapPanics(vm, func(call goja.FunctionCall) (goja.Value, error) {
			return goja.Undefined(), txn.Commit()
		}))
		obj.Set("abort", WrapPanics(vm, func(call goja.FunctionCall) (goja.Value, error) {
			txn.Abort()
			return goja.Undefined(), nil
		}))
		return obj, nil
	})

	return vm.New(cls, txnFn)
}

//

func consoleLog(call goja.FunctionCall) goja.Value {
	var out []string
	for _, arg := range call.Arguments {
		out = append(out, arg.String())
	}
	println(strings.Join(out, " "))
	return nil
}

// const NIBBLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
//
// // generateUuid is either injected into the environment or we expect to use crypto.getRandomValues()
// if (!globalThis.generateUuid) {
//   function generateUuid(): string {
//     let out = '';
//
//     // Get 128 bits of randomness.
//     const values = new Uint8Array(16);
//     crypto.getRandomValues(values);
//
//     // rfc4122 compliance: type 4 uuid
//     values[6] = 0x40 | (values[6] & 0x0f);
//     values[8] = 0x80 | (values[8] & 0x3f);
//
//     values.forEach((x) => {
//       out += NIBBLE[x >>> 4] + NIBBLE[x & 0x0f];
//     });
//
//     return [
//       out.substring(0, 8),
//       out.substring(8, 12),
//       out.substring(12, 16),
//       out.substring(16, 20),
//       out.substring(20, 32),
//     ].join('-');
//   }
// }

var hexifyNibbles = []byte{
	'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
}

func hexify(src []uint8, dst []byte) {
	for i, s := range src {
		dst[2*i] = hexifyNibbles[s>>4]
		dst[2*i+1] = hexifyNibbles[s&0x0f]
	}
}

func generateUuid(call goja.FunctionCall, vm *goja.Runtime) goja.Value {
	// get 128 bits of randomness
	var values [16]uint8
	_, _ = rand.Read(values[:])

	// rf4122 compliance: type 4 uuid
	values[6] = 0x40 | (values[6] & 0x0f)
	values[8] = 0x80 | (values[8] & 0x3f)

	// hexify with appropriate dashes
	var out [36]byte
	hexify(values[0:4], out[0:8])
	out[8] = '-'
	hexify(values[4:6], out[9:13])
	out[13] = '-'
	hexify(values[6:8], out[14:18])
	out[18] = '-'
	hexify(values[8:10], out[19:23])
	out[23] = '-'
	hexify(values[10:16], out[24:36])
	return vm.ToValue(string(out[:]))
}

func makeSetTimeout() (func(goja.FunctionCall) goja.Value, func() error) {
	// set up a circularly-linked list as a queue of callables
	type CallSoon struct {
		Func goja.Callable
		Link Link[CallSoon]
	}
	callSoonFromLink := LinkDerefFunc[CallSoon]("Link")
	var q Head[CallSoon]

	setTimeout := func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) == 0 {
			panic("setTimeout: missing function parameter")
		}
		if len(call.Arguments) > 1 {
			if timeout, ok := call.Arguments[1].Export().(int64); !ok || timeout != 0 {
				panic("setTimeout with nonzero timeout is forbidden")
			}
		}
		fn, ok := goja.AssertFunction(call.Arguments[0])
		if !ok {
			panic("setTimeout() requires a callable")
		}
		q.Append(&(&CallSoon{Func: fn}).Link)
		return goja.Undefined()
	}

	run := func() error {
		for {
			next := q.PopFirst(callSoonFromLink)
			if next == nil {
				return nil
			}
			_, err := next.Func(goja.Undefined())
			if err != nil {
				return err
			}
		}
	}

	return setTimeout, run
}

type Engine[QX QueryContext, E any, C any] struct {
	vm         *goja.Runtime
	eng        *goja.Object
	run        func() error
	newQuery   goja.Callable
	recvEvents goja.Callable
	reconnect  goja.Callable
	fellBehind goja.Callable
	caughtUp   goja.Callable
	qxFactory  func(*goja.Runtime, goja.Value, Ask) QX
}

func NewEngine[QX QueryContext, E any, C any](
	source Source,
	className string,
	store Store,
	migrate string,
	reducer string,
	qxFactory func(*goja.Runtime, goja.Value, Ask) QX,
) (*Engine[QX, E, C], error) {
	vm := goja.New()

	// configure a console.log()
	console := vm.NewObject()
	console.Set("log", consoleLog)
	vm.GlobalObject().Set("console", console)

	// configure a generateUuid()
	vm.GlobalObject().Set("generateUuid", generateUuid)

	// configure a setTimeout()
	setTimeout, run := makeSetTimeout()
	vm.GlobalObject().Set("setTimeout", setTimeout)

	// minimal CommonJS host: seed module.exports for the bundle to populate
	module := vm.NewObject()
	exports := vm.NewObject()
	module.Set("exports", exports)
	vm.GlobalObject().Set("module", module)
	vm.GlobalObject().Set("exports", exports)
	name, script, err := source.ToSource()
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	_, err = vm.RunScript(name, script)
	if err != nil {
		return nil, fmt.Errorf("loading bundle: %w", err)
	}
	vm.GlobalObject().Delete("module")
	vm.GlobalObject().Delete("exports")
	// copy the exports into the global namespace, where the migrate/reducer lookups happen;
	// re-read module.exports because bundles may reassign it instead of mutating the seed
	exported := module.Get("exports").ToObject(vm)
	for _, key := range exported.Keys() {
		vm.GlobalObject().Set(key, exported.Get(key))
	}

	var storeVal goja.Value
	if store == nil {
		// no store means "in-mem store", both in this go layer and in the typescript Engine layer
		storeVal = goja.Undefined()
	} else {
		storeVal, err = store.ToStore(vm)
		if err != nil {
			return nil, fmt.Errorf("store: %w", err)
		}
	}

	var migrateFn goja.Value
	if migrate != "" {
		migrateFn = vm.GlobalObject().Get(migrate)
		if migrateFn == nil {
			return nil, fmt.Errorf("unable to find migrate: no such symbol: %q", migrate)
		}
	}

	var reducerFn goja.Value
	reducerFn = vm.GlobalObject().Get(reducer)
	if reducerFn == nil {
		return nil, fmt.Errorf("unable to find reducer: no such symbol: %q", reducer)
	}

	// build callbacks
	callbacks := vm.NewObject()
	callbacks.Set("reducer", reducerFn)
	callbacks.Set("migrate", migrateFn)

	// call `new Engine()`
	engClass := vm.GlobalObject().Get(className)
	if engClass == nil {
		return nil, fmt.Errorf("unable to locate Engine subclass: no such symbol: %q", className)
	}
	engConstructor, ok := goja.AssertConstructor(engClass)
	if !ok {
		return nil, fmt.Errorf("symbol %q is not a constructor", className)
	}
	eng, err := engConstructor(nil, storeVal, callbacks)
	if err != nil {
		return nil, fmt.Errorf("new Engine(): %w", err)
	}

	// get methods now
	newQuery, ok := goja.AssertFunction(eng.Get("newQuery"))
	if !ok {
		return nil, errors.New(".newQuery() method not callable")
	}
	recvEvents, ok := goja.AssertFunction(eng.Get("recvEvents"))
	if !ok {
		return nil, errors.New(".recvEvents() method not callable")
	}
	reconnect, ok := goja.AssertFunction(eng.Get("reconnect"))
	if !ok {
		return nil, errors.New(".reconnect() method not callable")
	}
	fellBehind, ok := goja.AssertFunction(eng.Get("fellBehind"))
	if !ok {
		return nil, errors.New(".fellBehind() method not callable")
	}
	caughtUp, ok := goja.AssertFunction(eng.Get("caughtUp"))
	if !ok {
		return nil, errors.New(".caughtUp() method not callable")
	}

	return &Engine[QX, E, C]{
		vm,
		eng,
		run,
		newQuery,
		recvEvents,
		reconnect,
		fellBehind,
		caughtUp,
		qxFactory,
	}, nil
}

func (e *Engine[QX, E, C]) VM() *goja.Runtime {
	return e.vm
}

func (e *Engine[QX, E, C]) RecvEvents(rawEvents []goja.Value) error {
	_, err := e.recvEvents(e.eng, e.vm.ToValue(rawEvents))
	if err != nil {
		return err
	}
	return e.run()
}

func (e *Engine[QX, E, C]) FellBehind() error {
	_, err := e.fellBehind(e.eng)
	return err
}

func (e *Engine[QX, E, C]) CaughtUp() error {
	_, err := e.caughtUp(e.eng)
	return err
}

func (e *Engine[QX, E, C]) Reconnect() (*uint64, error) {
	var out *uint64
	jsfn := WrapPanics(e.vm, func(call goja.FunctionCall) (goja.Value, error) {
		// cb receives {checkpoint, commands}
		value := call.Argument(0).ToObject(e.vm).Get("checkpoint")
		// did we get a checkpoint value?
		if value == nil || goja.IsUndefined(value) {
			return nil, nil
		}
		// export received checkpoint value
		var checkpoint uint64
		err := e.vm.ExportTo(value, &checkpoint)
		if err != nil {
			return nil, fmt.Errorf(
				"exporting checkpoint value (%v) to target type (%T): %w", value, checkpoint, err,
			)
		}
		out = &checkpoint
		return nil, nil
	})
	_, err := e.reconnect(e.eng, jsfn)
	if err != nil {
		return nil, err
	}
	// the callback fires during a run-loop pump
	if err := e.run(); err != nil {
		return nil, err
	}
	return out, nil
}

type Query[T any] struct {
	vm    *goja.Runtime
	query *goja.Object
}

func (q *Query[T]) Close() {
	closeFn, ok := goja.AssertFunction(q.query.Get("close"))
	if !ok {
		panic("Query.close is not callable??")
	}
	_, err := closeFn(goja.Undefined(), q.query)
	if err != nil {
		panic(fmt.Sprintf("Query.close failed?? (%v)", err))
	}
}

func (q *Query[T]) Latest() *T {
	latest := q.query.Get("latest")
	if latest == nil || goja.IsUndefined(latest) {
		return nil
	}
	t := latest.Export().(T)
	return &t
}

// from within another query function, ask for the result of this query
func (q *Query[T]) Result(qx QueryContext) T {
	// yield {query: {id: true}}
	id := q.query.Get("id").Export().(string)
	query := q.vm.NewObject()
	query.Set(id, true)
	question := q.vm.NewObject()
	question.Set("query", query)
	// receive {query: {id: {result, dirty}}}
	answer := qx.Ask(question)
	return answer.(*goja.Object).
		Get("query").(*goja.Object).
		Get(id).(*goja.Object).
		Get("result").
		Export().(T)
}

// newcoro has three type parameters: "Q"uestion, "A"nswer, and "R"esult.
//
// It starts a coroutine that eventually returns `R` and has with access to an `ask func(Q) A`.
//
// It returns a `next func(A) (Q, R, done)`.
// While done is false, Q is valid.  When done is true, R is valid.
func newcoro[Q any, A any, R any](fn func(ask func(Q) A) R) func(A) (Q, R, bool) {
	var answer A
	var result R

	// It would be nice to use runtime.newcoro directly, but go doesn't allow it; the only way to
	// use it is via go:linkname, and that is forbidden by the linker by all packages except "iter".
	//
	// Afaict, that means the only existing consumer of runtime.newcoro is iter.Pull, so we'll just
	// have to wrap iter.Pull I guess.
	next, _ := iter.Pull[Q](func(yield func(Q) bool) {
		// wrap the unidirectional `yield` in a bidirectional `ask`.  The answer comes by
		// examining the `answer` value, which must be updated after the coro calls `yield`
		// and before calling `next` again.
		ask := func(question Q) A {
			if !yield(question) {
				// this should never happen as we don't use stop() ever; we rely on either
				// finishing the coroutine or the go runtime garbage collecting it.
				panic("query was canceled early")
			}
			// return the answer provided by next
			return answer
		}
		// run the provided coroutine function
		result = fn(ask)
	})

	nextfunc := func(val A) (Q, R, bool) {
		// set answer for `ask()` to return inside the coro
		answer = val
		question, ok := next()
		return question, result, !ok
	}

	return nextfunc
}

func (q *Query[T]) Subscribe(fn func(T)) func() {
	jsfn := func(call goja.FunctionCall) goja.Value {
		// only argument is a goja-wrapped `T`
		fn(call.Arguments[0].Export().(T))
		return goja.Undefined()
	}
	sub := q.query.Get("subscribe")
	subFn, ok := goja.AssertFunction(sub)
	if !ok {
		panic("Query.subscribe is not callable??")
	}

	// call Query.subscribe(fn), which never throws
	unsub, err := subFn(q.query, q.vm.ToValue(jsfn))
	if err != nil {
		// should never happen
		panic("Query.subscribe failed??")
	}

	unsubFn, ok := goja.AssertFunction(unsub)
	if !ok {
		panic("Query.subscribe() returns non-callable unsubscribe??")
	}

	return func() {
		_, err := unsubFn(goja.Undefined())
		if err != nil {
			panic(fmt.Sprintf("Query unsubscribe failed?? (%v)", err))
		}
	}
}

func NewQuery[QX QueryContext, E any, C any, T any](
	eng *Engine[QX, E, C],
	fn func(vm *goja.Runtime, qx QX) T,
) *Query[T] {
	// each time a query is run, we create a new javascript iterator around a new coroutine
	queryfunc := func(call goja.FunctionCall) goja.Value {
		// arg is just (qx: javscriptQX)
		jsqx := call.Arguments[0]

		// start query function in a goroutine
		next := newcoro[goja.Value, goja.Value, T](func(ask func(goja.Value) goja.Value) T {
			qx := eng.qxFactory(eng.vm, jsqx, ask)
			return fn(eng.vm, qx)
		})

		// return something that looks like a javascript iterator
		it := eng.vm.NewObject()
		it.Set("next", WrapPanics(eng.vm, func(call goja.FunctionCall) (goja.Value, error) {
			question, result, done := next(call.Arguments[0])
			// return {value, done}
			out := eng.vm.NewObject()
			out.Set("done", done)
			if !done {
				out.Set("value", question)
			} else {
				out.Set("value", result)
			}
			return out, nil
		}))

		return it
	}

	// call javascript method: Engine.newQuery(), which should not throw
	query, err := eng.newQuery(eng.eng, eng.vm.ToValue(queryfunc))
	if err != nil {
		panic("engine.newQuery failed??")
	}

	return &Query[T]{
		vm:    eng.vm,
		query: query.(*goja.Object),
	}
}

// helpers for dealing with metadata-wrapped event types

func CheckIdentified(
	vm *goja.Runtime,
	value goja.Value,
	path string,
	subChecker func(*goja.Runtime, goja.Value, string) error,
) error {
	var errs []error
	obj, ok := value.(*goja.Object)
	if !ok {
		return fmt.Errorf("%v: is a %v, not a json object", path, value.ExportType())
	}
	if field := obj.Get("id"); field != nil {
		xpath := path + ".id"
		if typ := field.ExportType(); typ != reflectTypeString {
			errs = append(errs, fmt.Errorf("%v: is of type %v, not string", xpath, typ))
		}
	} else {
		errs = append(errs, fmt.Errorf("%v: missing required field", path))
	}
	if field := obj.Get("data"); field != nil {
		xpath := path + ".data"
		err := subChecker(vm, field, xpath)
		// unwrap the inner errors.Join()
		unwrapper, ok := err.(interface{ Unwrap() []error })
		if ok {
			errs = append(errs, unwrapper.Unwrap()...)
		} else {
			errs = append(errs, err)
		}
	} else {
		errs = append(errs, fmt.Errorf("%v: missing required field", path))
	}
	return errors.Join(errs...)
}
