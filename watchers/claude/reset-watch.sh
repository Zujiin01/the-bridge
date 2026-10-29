#!/usr/bin/env bash
# Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
# WATCHER 2 (reset) for Claude. A Monitor lives 30 minutes at most: this one wakes Claude after 28 minutes
# so it restarts both watchers before they expire. Start it with the Monitor tool (timeout_ms=1800000).
sleep "${BRIDGE_RESET_AFTER:-1680}"
echo "RESTART: restart both watchers (inbox + reset)"
