#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }

SANDBOX_URL="${SANDBOX_URL:-http://localhost:2000}"

test_basic_python() {
    log_info "Testing basic Python execution..."
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d '{"language":"python","version":"3.14.4","files":[{"content":"print(42)"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "42"* ]]; then
        log_success "Basic Python: got '$stdout'"
        return 0
    else
        log_error "Basic Python: expected '42', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_numpy() {
    log_info "Testing numpy import..."
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d '{"language":"python","version":"3.14.4","files":[{"content":"import numpy as np\nprint(np.array([1,2,3]).sum())"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "6"* ]]; then
        log_success "Numpy: got '$stdout'"
        return 0
    else
        log_error "Numpy: expected '6', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_chdb() {
    log_info "Testing chDB import and query..."
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d '{"language":"python","version":"3.14.4","files":[{"content":"import chdb\nprint(chdb.query(\"SELECT sum(number) FROM numbers(5)\", \"CSV\"))"}]}')

    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "10"* ]]; then
        log_success "chDB: got '$stdout'"
        return 0
    else
        log_error "chDB: expected '10', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_file_write() {
    log_info "Testing file write in sandbox..."
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d '{"language":"python","version":"3.14.4","files":[{"content":"with open(\"/mnt/data/test.txt\", \"w\") as f:\n    f.write(\"hello\")\nwith open(\"/mnt/data/test.txt\") as f:\n    print(f.read())"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "hello"* ]]; then
        log_success "File write: got '$stdout'"
        return 0
    else
        log_error "File write: expected 'hello', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_network_blocked() {
    log_info "Testing network is blocked..."
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d '{"language":"python","version":"3.14.4","files":[{"content":"import socket\ntry:\n    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n    s.settimeout(2)\n    s.connect((\"8.8.8.8\", 53))\n    print(\"NETWORK_ALLOWED\")\nexcept Exception as e:\n    print(\"NETWORK_BLOCKED\")"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "NETWORK_BLOCKED"* ]]; then
        log_success "Network blocked: sandbox correctly isolated"
        return 0
    else
        log_error "Network NOT blocked: sandbox may be misconfigured"
        echo "$result" | jq .
        return 1
    fi
}

test_bun() {
    log_info "Testing Bun/JavaScript execution..."
    # Get available bun version dynamically
    bun_version=$(curl -s "$SANDBOX_URL/api/v2/runtimes" | jq -r '.[] | select(.runtime == "bun" and .language == "javascript") | .version' | head -1)
    if [ -z "$bun_version" ]; then
        log_warn "Bun runtime not available, skipping"
        return 0
    fi
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d "{\"language\":\"javascript\",\"version\":\"$bun_version\",\"runtime\":\"bun\",\"files\":[{\"content\":\"console.log(1 + 2)\"}]}")
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    if [[ "$stdout" == "3"* ]]; then
        log_success "Bun JS: got '$stdout'"
        return 0
    else
        log_error "Bun JS: expected '3', got '$stdout'"
        echo "$result" | jq .
        return 1
    fi
}

test_escape_attempt() {
    log_info "Testing escape attempt (should fail)..."
    result=$(curl -s "$SANDBOX_URL/api/v2/execute" \
        -H 'Content-Type: application/json' \
        -d '{"language":"python","version":"3.14.4","files":[{"content":"import os\ntry:\n    os.system(\"cat /etc/shadow\")\n    print(\"ESCAPE_POSSIBLE\")\nexcept:\n    print(\"ESCAPE_BLOCKED\")"}]}')
    
    stdout=$(echo "$result" | jq -r '.run.stdout // empty')
    stderr=$(echo "$result" | jq -r '.run.stderr // empty')
    
    if [[ "$stdout" != *"root:"* ]] && [[ "$stderr" != *"root:"* ]]; then
        log_success "Escape blocked: /etc/shadow not readable"
        return 0
    else
        log_error "SECURITY ISSUE: /etc/shadow was readable!"
        echo "$result" | jq .
        return 1
    fi
}

echo "=============================================="
echo "  Sandbox Security Test Suite"
echo "=============================================="
echo "Target: $SANDBOX_URL"
echo ""

FAILED=0

test_basic_python || FAILED=$((FAILED + 1))
test_numpy || FAILED=$((FAILED + 1))
test_chdb || FAILED=$((FAILED + 1))
test_file_write || FAILED=$((FAILED + 1))
test_network_blocked || FAILED=$((FAILED + 1))
test_bun || FAILED=$((FAILED + 1))
test_escape_attempt || FAILED=$((FAILED + 1))

echo ""
echo "=============================================="
if [[ $FAILED -eq 0 ]]; then
    log_success "All tests passed!"
    exit 0
else
    log_error "$FAILED test(s) failed"
    exit 1
fi
