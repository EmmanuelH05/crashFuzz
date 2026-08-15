# LD_PRELOAD interposer used for syscall trace capture (Phase 1).
# Linux only.
#
#   make          build/shim.so
#   make probe    build/probe.so - minimal interposer used during target
#                 selection to confirm a candidate routes file I/O through libc

CC      ?= clang
BUILD   := build
CFLAGS  := -std=c11 -O2 -g -Wall -Wextra -Werror -fPIC -pthread \
           -D_GNU_SOURCE -fvisibility=hidden
LDFLAGS := -shared -ldl -pthread

# probe.c builds into its own shared object and is excluded from shim.so.
SRCS := $(filter-out src/probe.c,$(wildcard src/*.c))
OBJS := $(patsubst src/%.c,$(BUILD)/%.o,$(SRCS))

.PHONY: all probe clean check-platform

all: check-platform $(BUILD)/shim.so

probe: check-platform $(BUILD)/probe.so

$(BUILD)/probe.so: src/probe.c | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<

check-platform:
	@[ "$$(uname -s)" = "Linux" ] || { \
	  echo "error: shim requires Linux; use 'bun run vm:sh'" >&2; exit 1; }

$(BUILD)/shim.so: $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $^

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
