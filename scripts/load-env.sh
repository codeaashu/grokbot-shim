#!/usr/bin/env bash

# This file is sourced by the launchers. Keep it side-effect free apart from
# exporting values from the repository-local .env file.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
