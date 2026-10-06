CC ?= cc
CFLAGS ?= -O2 -g
CFLAGS += -std=gnu11 -Wall -Wextra -Wno-unused-parameter -fPIC
CPPFLAGS += -Ivendor/mpack -I$(QJS) -DMPACK_EXTENSIONS=1

QJS = ../../examples/library/relay/quickjs
QJS_OBJS = quickjs libregexp libunicode cutils dtoa

OBJS = pldb.o store.o scan.o scantest.o mpjs.o js.o walk.o names.o crc32c.o mpack.o \
       $(foreach o,$(QJS_OBJS),qjs_$(o).o)

libpldb.a: $(OBJS)
	ar rcs $@ $(OBJS)

pldb.o: pldb.c pldb.h internal.h walk.h
store.o: store.c internal.h
scan.o: scan.c internal.h
scantest.o: scantest.c internal.h
mpjs.o: mpjs.c internal.h
js.o: js.c internal.h host_js.h walk.h
walk.o: walk.c walk.h internal.h
names.o: names.c internal.h
crc32c.o: crc32c.c internal.h

host_js.h: host.js
	xxd -i host.js > $@

mpack.o: vendor/mpack/mpack.c vendor/mpack/mpack.h
	$(CC) $(CPPFLAGS) -std=c11 -O2 -g -w -fPIC -c -o $@ vendor/mpack/mpack.c

$(QJS)/.obj/%.pic.o:
	$(MAKE) -C $(QJS) .obj/$*.pic.o

qjs_%.o: $(QJS)/.obj/%.pic.o
	cp $< $@

clean:
	rm -f *.o *.a host_js.h

.PHONY: clean
