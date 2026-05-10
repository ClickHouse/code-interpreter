#!/bin/bash
# Run sandbox tests from within Docker network
# This works around Docker Desktop port forwarding issues in WSL2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NETWORK="${DOCKER_NETWORK:-codeapi_default}"
SANDBOX_HOST="${SANDBOX_HOST:-sandbox}"

echo "Running sandbox tests via Docker network: $NETWORK"
echo "Sandbox host: $SANDBOX_HOST"
echo ""

# Run tests using a curl container in the same network
# Pipe the script content to avoid volume mount issues
cat "$SCRIPT_DIR/test-sandbox.sh" | docker run --rm -i --network "$NETWORK" \
    -e SANDBOX_URL="http://${SANDBOX_HOST}:2000" \
    alpine:latest sh -c '
        apk add --no-cache bash curl jq nodejs >/dev/null 2>&1
        cat > /tmp/test.sh
        chmod +x /tmp/test.sh
        /tmp/test.sh
    '
