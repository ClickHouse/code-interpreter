#!/bin/bash
set -e

# Resolve Docker Compose service names to IPs before entering the microVM.
# libkrun's TSI networking doesn't have access to Docker's embedded DNS (127.0.0.11),
# so DNS-based service discovery won't work inside the guest.

resolve_url() {
    local var_name="$1"
    local url="${!var_name}"
    [ -z "$url" ] && return

    local proto="${url%%://*}"
    local rest="${url#*://}"
    local host_port="${rest%%/*}"
    local path="/${rest#*/}"
    [ "$rest" = "$host_port" ] && path=""
    local host="${host_port%%:*}"
    local port="${host_port#*:}"
    [ "$host" = "$port" ] && port=""

    # Skip if already an IP
    echo "$host" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' && return

    local ip
    ip=$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | head -1)
    if [ -n "$ip" ]; then
        local new_url="${proto}://${ip}"
        [ -n "$port" ] && new_url="${new_url}:${port}"
        new_url="${new_url}${path}"
        export "$var_name"="$new_url"
        echo "[entrypoint] ${var_name}: ${host} -> ${ip}"
    fi
}

resolve_host_port() {
    local var_name="$1"
    local val="${!var_name}"
    [ -z "$val" ] && return

    local host="${val%%:*}"
    local port="${val#*:}"

    echo "$host" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' && return

    local ip
    ip=$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | head -1)
    if [ -n "$ip" ]; then
        export "$var_name"="${ip}:${port}"
        echo "[entrypoint] ${var_name}: ${host} -> ${ip}"
    fi
}

resolve_url EGRESS_GATEWAY_URL
resolve_url FILE_SERVER_URL
resolve_host_port SANDBOX_FORWARD_TARGET

if [ "${LAUNCHER_FILTER_VSOCK_ENOTCONN:-true}" = "true" ]; then
    # libkrun can emit this benign TSI/vsock teardown line after the guest has
    # already closed its side of the socket. It contains the word "error", so
    # text-based log panels count it as an app failure unless we drop it here.
    exec /usr/local/bin/launcher "$@" \
        2> >(grep --line-buffered -vF 'devices::virtio::vsock::tsi_stream error sending shutdown to socket: ENOTCONN' >&2)
fi

exec /usr/local/bin/launcher "$@"
