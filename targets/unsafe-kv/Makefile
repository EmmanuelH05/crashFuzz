# Deliberately unsafe key-value store, the positive control (Phase 3).
# Linux only.
#
#   make    build/unsafe-kv

CC      ?= clang
BUILD   := build
CFLAGS  := -std=c11 -O2 -g -Wall -Wextra -Werror -D_GNU_SOURCE

SHA256 := ../../shim/src/sha256.c

.PHONY: all clean

all: $(BUILD)/unsafe-kv

$(BUILD)/unsafe-kv: main.c $(SHA256) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ main.c $(SHA256)

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
