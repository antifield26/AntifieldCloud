#!/usr/bin/env bash
set -euo pipefail
curl -fsS -m 5 http://127.0.0.1:3000/health
echo
ss -tlnp | grep -E '3000|4096' || true
