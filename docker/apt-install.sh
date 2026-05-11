#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: apt-install <package>..." >&2
  exit 64
fi

attempt=1
max_attempts="${APT_INSTALL_ATTEMPTS:-4}"

while [ "$attempt" -le "$max_attempts" ]; do
  echo "apt-install attempt ${attempt}/${max_attempts}: $*"
  rm -rf /var/lib/apt/lists/*

  if apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends "$@"; then
    rm -rf /var/lib/apt/lists/*
    exit 0
  else
    status="$?"
  fi

  rm -rf /var/lib/apt/lists/*

  if [ "$attempt" -eq "$max_attempts" ]; then
    exit "$status"
  fi

  sleep "$((attempt * 5))"
  attempt="$((attempt + 1))"
done
