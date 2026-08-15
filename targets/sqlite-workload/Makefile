# SQLite control workload (Phase 3). Linux only.
#
#   make    build/sqlite-workload

CC      ?= clang
BUILD   := build
CFLAGS  := -std=c11 -O2 -g -Wall -Wextra -Werror -D_GNU_SOURCE
LDFLAGS := -lsqlite3

SHA256 := ../../shim/src/sha256.c

.PHONY: all clean

all: $(BUILD)/sqlite-workload $(BUILD)/sqlite-query

$(BUILD)/sqlite-workload: main.c $(SHA256) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ main.c $(SHA256) $(LDFLAGS)

$(BUILD)/sqlite-query: query.c $(SHA256) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ query.c $(SHA256) $(LDFLAGS)

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
