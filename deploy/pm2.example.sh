#!/usr/bin/env bash
# Copyright (c) 2026 Technologies GNETICS Inc. - PolyForm Noncommercial 1.0.0 (non-commercial use only, see LICENSE)
# Run bridge-wake under pm2 instead of systemd (same user as the bridge folder). Adapt the two paths.
pm2 start bin/bridge-wake.js --name bridge-wake-grokbot -- --config "$HOME/.config/bridge/wake.json"
pm2 save
pm2 logs bridge-wake-grokbot --lines 20
