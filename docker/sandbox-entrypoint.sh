#!/bin/bash
set -e

KVM_ENABLED="${KVM_ENABLED:-true}"

if [ "$KVM_ENABLED" = "true" ]; then
    exec /usr/local/bin/launcher-entrypoint.sh "$@"
fi

exec /usr/local/bin/start-direct-sandbox.sh "$@"
