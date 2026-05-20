#!/bin/bash

# =============================================================================
# Programmatic Tool Calling Test Script
# =============================================================================
# This script simulates an external client making programmatic tool calls.
# It handles the full request-response cycle including tool call continuations.
# =============================================================================

set -e

# Load .env file if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
SERVICE_URL="${SERVICE_URL:-http://localhost:3112}"
BEARER_TOKEN="${CODEAPI_BEARER_TOKEN:-${BEARER_TOKEN:-}}"
MAX_ITERATIONS=10
POLL_INTERVAL=1

# Validate bearer token
if [ -z "$BEARER_TOKEN" ]; then
    echo "Error: BEARER_TOKEN not set. Either:"
    echo "  1. Set BEARER_TOKEN environment variable"
    echo "  2. Add BEARER_TOKEN=your-key to .env file"
    echo "  3. Export BEARER_TOKEN in your shell"
    exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Simulate executing a tool locally
execute_tool() {
    local tool_name="$1"
    local tool_input="$2"
    
    # Log to stderr so it doesn't corrupt JSON output
    log_info "Executing tool: $tool_name with input: $tool_input" >&2
    
    case "$tool_name" in
        "get_weather")
            local city=$(echo "$tool_input" | jq -r '.city // "Unknown"')
            # Return different temperatures for different cities
            case "$city" in
                "San Francisco")
                    echo "{\"temperature\": 68, \"condition\": \"foggy\", \"city\": \"$city\"}"
                    ;;
                "New York")
                    echo "{\"temperature\": 45, \"condition\": \"cloudy\", \"city\": \"$city\"}"
                    ;;
                "London")
                    echo "{\"temperature\": 52, \"condition\": \"rainy\", \"city\": \"$city\"}"
                    ;;
                *)
                    echo "{\"temperature\": 72, \"condition\": \"sunny\", \"city\": \"$city\"}"
                    ;;
            esac
            ;;
        "get_expenses")
            local user_id=$(echo "$tool_input" | jq -r '.user_id // "unknown"')
            echo "[{\"id\": \"exp_1\", \"amount\": 150.00, \"description\": \"Office supplies\", \"user_id\": \"$user_id\"}, {\"id\": \"exp_2\", \"amount\": 75.50, \"description\": \"Travel\", \"user_id\": \"$user_id\"}]"
            ;;
        "get_team_members")
            echo "[{\"id\": \"u1\", \"name\": \"Alice\"}, {\"id\": \"u2\", \"name\": \"Bob\"}, {\"id\": \"u3\", \"name\": \"Charlie\"}]"
            ;;
        "get_user_id")
            local email=$(echo "$tool_input" | jq -r '.email // "unknown"')
            # Return user ID based on email
            case "$email" in
                "alice@company.com")
                    echo "\"usr_alice_123\""
                    ;;
                *)
                    echo "\"usr_unknown\""
                    ;;
            esac
            ;;
        "get_user_profile")
            local user_id=$(echo "$tool_input" | jq -r '.user_id // "unknown"')
            # Return profile based on user ID
            case "$user_id" in
                "usr_alice_123")
                    echo "{\"name\": \"Alice Smith\", \"department\": \"Engineering\", \"role\": \"Senior Developer\"}"
                    ;;
                *)
                    echo "{\"name\": \"Unknown User\", \"department\": \"Unknown\", \"role\": \"Unknown\"}"
                    ;;
            esac
            ;;
        "get_department_budget")
            local department=$(echo "$tool_input" | jq -r '.department // "unknown"')
            # Return budget based on department
            case "$department" in
                "Engineering")
                    echo "{\"department\": \"Engineering\", \"amount\": 500000.00, \"remaining\": 325000.00, \"currency\": \"USD\"}"
                    ;;
                "Sales")
                    echo "{\"department\": \"Sales\", \"amount\": 300000.00, \"remaining\": 125000.00, \"currency\": \"USD\"}"
                    ;;
                *)
                    echo "{\"department\": \"$department\", \"amount\": 100000.00, \"remaining\": 50000.00, \"currency\": \"USD\"}"
                    ;;
            esac
            ;;
        "calculate")
            local expression=$(echo "$tool_input" | jq -r '.expression // "0"')
            # Simple evaluation (be careful with this in production!)
            local result=$(echo "$expression" | bc -l 2>/dev/null || echo "0")
            echo "{\"result\": $result}"
            ;;
        "list_databases_mcp_ClickHouse")
            local service_id=$(echo "$tool_input" | jq -r '.serviceId // "unknown"')
            echo "{\"serviceId\":\"$service_id\",\"databases\":[\"default\",\"system\"]}"
            ;;
        "list_tables_mcp_ClickHouse")
            local service_id=$(echo "$tool_input" | jq -r '.serviceId // "unknown"')
            local database=$(echo "$tool_input" | jq -r '.database // "default"')
            echo "{\"serviceId\":\"$service_id\",\"database\":\"$database\",\"tables\":[\"events\",\"metrics\"]}"
            ;;
        *)
            log_warn "Unknown tool: $tool_name, returning mock response" >&2
            echo "{\"mock\": true, \"tool\": \"$tool_name\"}"
            ;;
    esac
}

# Process tool calls and return results
process_tool_calls() {
    local tool_calls="$1"
    local results="[]"
    
    # Iterate over each tool call
    local count=$(echo "$tool_calls" | jq 'length')
    for ((i=0; i<count; i++)); do
        local call=$(echo "$tool_calls" | jq ".[$i]")
        local call_id=$(echo "$call" | jq -r '.id')
        local tool_name=$(echo "$call" | jq -r '.name')
        local tool_input=$(echo "$call" | jq -c '.input')
        
        log_info "Processing tool call $call_id: $tool_name" >&2
        
        # Execute the tool and capture result
        local tool_result
        tool_result=$(execute_tool "$tool_name" "$tool_input")
        
        log_info "Tool result: $tool_result" >&2
        
        # Validate it's valid JSON
        if ! echo "$tool_result" | jq . > /dev/null 2>&1; then
            log_error "Invalid JSON from tool: $tool_result" >&2
            tool_result='{"error": "Invalid tool response"}'
        fi
        
        # Add to results array using a temp file to avoid escaping issues
        local tmp_result=$(mktemp)
        echo "$tool_result" > "$tmp_result"
        results=$(jq --arg id "$call_id" --slurpfile result "$tmp_result" \
            '. + [{"call_id": $id, "result": $result[0], "is_error": false}]' <<< "$results")
        rm -f "$tmp_result"
    done
    
    echo "$results"
}

# Main test function. Optional 4th arg: language (python|bash), default python.
run_test() {
    local code="$1"
    local tools="$2"
    local test_name="${3:-Test}"
    local language="${4:-python}"
    
    echo ""
    echo "============================================================================="
    log_info "Starting: $test_name"
    echo "============================================================================="
    
    # Initial request
    log_info "Sending initial execution request..."
    
    local response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{
            \"code\": $(echo "$code" | jq -Rs .),
            \"tools\": $tools,
            \"language\": \"$language\"
        }")
    
    echo "$response" | jq '.' 2>/dev/null || echo "$response"
    
    local status=$(echo "$response" | jq -r '.status // "unknown"')
    local continuation_token=$(echo "$response" | jq -r '.continuation_token // empty')
    local iteration=0
    
    # Loop until completed or error
    while [[ "$status" == "tool_call_required" ]] && [[ $iteration -lt $MAX_ITERATIONS ]]; do
        iteration=$((iteration + 1))
        log_info "Iteration $iteration: Tool calls required"
        
        # Get pending tool calls
        local tool_calls=$(echo "$response" | jq '.tool_calls')
        log_info "Pending tool calls: $(echo "$tool_calls" | jq -c '.')"
        
        # Process tool calls
        local tool_results=$(process_tool_calls "$tool_calls")
        log_info "Tool results: $(echo "$tool_results" | jq -c '.')"
        
        # Send continuation request
        log_info "Sending continuation request..."
        sleep "$POLL_INTERVAL"
        
        response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $BEARER_TOKEN" \
            -d "{
                \"continuation_token\": \"$continuation_token\",
                \"tool_results\": $tool_results
            }")
        
        echo "$response" | jq '.' 2>/dev/null || echo "$response"
        
        status=$(echo "$response" | jq -r '.status // "unknown"')
        continuation_token=$(echo "$response" | jq -r '.continuation_token // empty')
    done
    
    # Final status
    echo ""
    if [[ "$status" == "completed" ]]; then
        log_success "Execution completed!"
        echo "stdout:"
        echo "$response" | jq -r '.stdout // "N/A"'
    elif [[ "$status" == "error" ]]; then
        log_error "Execution failed!"
        echo "$response" | jq '.error, .stderr'
        return 1
    elif [[ $iteration -ge $MAX_ITERATIONS ]]; then
        log_error "Max iterations reached!"
        return 1
    else
        log_warn "Unknown status: $status"
        return 1
    fi
    
    echo "============================================================================="
    echo ""
}

# =============================================================================
# Test Cases
# =============================================================================

# Test 1: Simple single tool call with top-level await
test_simple() {
    local code='# Top-level await (auto-wrapped by Code API)
result = await get_weather(city="San Francisco")
print(f"Weather: {result}")'

    local tools='[
        {
            "name": "get_weather",
            "description": "Get weather for a city. Returns dict with temperature and condition.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"}
                },
                "required": ["city"]
            }
        }
    ]'
    
    run_test "$code" "$tools" "Simple Weather Test"
}

# Test 2: Multiple tool calls in sequence with top-level await
test_multiple() {
    local code='# Top-level await
team = await get_team_members()
print(f"Team has {len(team)} members")
for member in team:
    name = member.get("name", "Unknown")
    print(f"- {name}")'

    local tools='[
        {
            "name": "get_team_members",
            "description": "Get list of team members. Returns list of dicts with id and name.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    ]'
    
    run_test "$code" "$tools" "Team Members Test"
}

# Test 3: Tool calls in a loop with top-level await
test_loop() {
    local code='# Top-level await in loop
team = await get_team_members()
total = 0
for member in team:
    expenses = await get_expenses(user_id=member["id"])
    member_total = sum(e["amount"] for e in expenses)
    total += member_total
    member_name = member.get("name", "Unknown")
    print(f"{member_name}: ${member_total:.2f}")
print(f"Grand total: ${total:.2f}")'

    local tools='[
        {
            "name": "get_team_members",
            "description": "Get list of team members. Returns list of dicts with id and name.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "get_expenses",
            "description": "Get expenses for a user. Returns list of expense objects.",
            "parameters": {
                "type": "object",
                "properties": {
                    "user_id": {"type": "string", "description": "User ID"}
                },
                "required": ["user_id"]
            }
        }
    ]'
    
    run_test "$code" "$tools" "Expenses Loop Test"
}

# Test 4: Calculator with top-level await
test_calculator() {
    local code='# Top-level await
result = await calculate(expression="2 + 2 * 3")
calc_result = result.get("result", "N/A")
print(f"Result: {calc_result}")'

    local tools='[
        {
            "name": "calculate",
            "description": "Evaluate a math expression. Returns dict with result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "Math expression"}
                },
                "required": ["expression"]
            }
        }
    ]'
    
    run_test "$code" "$tools" "Calculator Test"
}

# Test 5: Chained tool calls (output of one feeds into next)
test_chained() {
    local code='# Top-level await with chained dependencies
# Step 1: Get user ID from email
user_id = await get_user_id(email="alice@company.com")
print(f"User ID: {user_id}")

# Step 2: Get user profile using that ID
profile = await get_user_profile(user_id=user_id)
department = profile.get("department", "Unknown")
print(f"Department: {department}")

# Step 3: Get department budget using that department
budget = await get_department_budget(department=department)
amount = budget.get("amount", 0)
remaining = budget.get("remaining", 0)
print(f"Budget: {amount}")
print(f"Remaining: {remaining}")'

    local tools='[
        {
            "name": "get_user_id",
            "description": "Get user ID from email. Returns string user ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "email": {"type": "string", "description": "User email address"}
                },
                "required": ["email"]
            }
        },
        {
            "name": "get_user_profile",
            "description": "Get user profile. Returns dict with name, department, role.",
            "parameters": {
                "type": "object",
                "properties": {
                    "user_id": {"type": "string", "description": "User ID"}
                },
                "required": ["user_id"]
            }
        },
        {
            "name": "get_department_budget",
            "description": "Get department budget info. Returns dict with amount and remaining.",
            "parameters": {
                "type": "object",
                "properties": {
                    "department": {"type": "string", "description": "Department name"}
                },
                "required": ["department"]
            }
        }
    ]'
    
    run_test "$code" "$tools" "Chained Tool Calls Test"
}

# Test 6: Async Parallel Execution with top-level await
test_async() {
    local code='# Top-level await with asyncio.gather for parallel execution
import asyncio

cities = ["San Francisco", "New York", "London"]
tasks = [get_weather(city=city) for city in cities]
results = await asyncio.gather(*tasks)

for i, city in enumerate(cities):
    weather = results[i]
    temp = weather.get("temperature", "N/A")
    cond = weather.get("condition", "N/A")
    print(f"{city}: {temp} degrees, {cond}")'

    local tools='[
        {
            "name": "get_weather",
            "description": "Get weather for a city. Returns dict with temperature and condition.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"}
                },
                "required": ["city"]
            }
        }
    ]'
    
    run_test "$code" "$tools" "Async Parallel Weather Test"
}

# Test: Tool returns is_error=true -> Python sees ToolExecutionError
test_error_tool() {
    local code='# Expect ToolExecutionError to bubble up from the cached error result
try:
    result = await calculate(expression="1/0")
    print(f"Unexpected success: {result}")
except ToolExecutionError as e:
    print(f"Caught expected ToolExecutionError: {e}")
'

    local tools='[
        {
            "name": "calculate",
            "description": "Evaluate a math expression. Returns dict with result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "Math expression"}
                },
                "required": ["expression"]
            }
        }
    ]'

    echo ""
    echo "============================================================================="
    log_info "Starting: Errored Tool Result"
    echo "============================================================================="

    local response
    response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{\"code\": $(echo "$code" | jq -Rs .), \"tools\": $tools}")
    echo "$response" | jq '.'

    local continuation_token
    continuation_token=$(echo "$response" | jq -r '.continuation_token // empty')
    local tool_calls
    tool_calls=$(echo "$response" | jq -c '.tool_calls // []')
    local call_id
    call_id=$(echo "$tool_calls" | jq -r '.[0].id')

    if [ -z "$continuation_token" ] || [ -z "$call_id" ]; then
        log_error "Expected tool_call_required with a call_id, got: $response"
        return 1
    fi

    local error_results
    error_results=$(jq -n --arg id "$call_id" \
        '[{"call_id": $id, "result": null, "is_error": true, "error_message": "division by zero"}]')

    response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{\"continuation_token\": \"$continuation_token\", \"tool_results\": $error_results}")
    echo "$response" | jq '.'

    if echo "$response" | jq -e '.stdout | test("Caught expected ToolExecutionError")' > /dev/null; then
        log_success "ToolExecutionError surfaced to user code as expected"
    else
        log_error "Expected ToolExecutionError caught in stdout; got: $(echo "$response" | jq -r '.stdout // .error')"
        return 1
    fi
    echo "============================================================================="
}

# Test: Expired / unknown continuation token -> 404
test_expired_token() {
    echo ""
    echo "============================================================================="
    log_info "Starting: Expired Continuation Token"
    echo "============================================================================="

    local now_ms
    now_ms=$(
        node -e 'console.log(Date.now())' 2>/dev/null ||
        bun -e 'console.log(Date.now())' 2>/dev/null ||
        python3 -c 'import time; print(int(time.time() * 1000))'
    )
    local unknown_token
    unknown_token=$(printf '{"execution_id":"does-not-exist","ts":%s}' "$now_ms" | base64 -w0 2>/dev/null || printf '{"execution_id":"does-not-exist","ts":%s}' "$now_ms" | base64)

    local http_code
    http_code=$(curl -s -o /tmp/ptc_expired_body.json -w "%{http_code}" \
        -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{\"continuation_token\": \"$unknown_token\", \"tool_results\": [{\"call_id\": \"call_001\", \"result\": {\"ok\": true}}]}")
    cat /tmp/ptc_expired_body.json | jq '.' 2>/dev/null || cat /tmp/ptc_expired_body.json

    if [ "$http_code" = "404" ]; then
        log_success "Unknown execution_id with fresh ts returned 404 as expected"
    else
        log_error "Expected 404 for unknown execution_id, got $http_code"
        return 1
    fi

    local stale_token
    stale_token=$(printf '{"execution_id":"does-not-exist","ts":1}' | base64 -w0 2>/dev/null || printf '{"execution_id":"does-not-exist","ts":1}' | base64)
    http_code=$(curl -s -o /tmp/ptc_expired_body.json -w "%{http_code}" \
        -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{\"continuation_token\": \"$stale_token\", \"tool_results\": [{\"call_id\": \"call_001\", \"result\": {\"ok\": true}}]}")
    cat /tmp/ptc_expired_body.json | jq '.' 2>/dev/null || cat /tmp/ptc_expired_body.json

    if [ "$http_code" = "400" ]; then
        log_success "Token with stale ts (older than TTL) returned 400 as expected"
    else
        log_error "Expected 400 for stale-ts token, got $http_code"
        return 1
    fi
    echo "============================================================================="
}

# Test: Code with zero tool calls completes in one roundtrip
test_no_calls() {
    local code='# No tool calls — should complete in one shot
total = 0
for i in range(10):
    total += i
print(f"sum(0..9) = {total}")'
    local tools='[
        {
            "name": "get_weather",
            "description": "Unused tool.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"]
            }
        }
    ]'
    run_test "$code" "$tools" "Zero Tool Calls"
}

# Test 7: Matplotlib + Tool Calls Combined
test_matplotlib() {
    local code='# Test matplotlib with async tool calls
import matplotlib.pyplot as plt

# Get weather data using async tool call
weather = await get_weather(city="San Francisco")
temp = weather.get("temperature", 72)
condition = weather.get("condition", "sunny")

# Create a simple plot
hours = [9, 12, 15, 18, 21]
temps = [temp - 5, temp, temp + 3, temp - 2, temp - 8]

plt.figure(figsize=(8, 5))
plt.plot(hours, temps, marker="o", linewidth=2, markersize=8)
plt.xlabel("Hour of Day")
plt.ylabel("Temperature (°F)")
plt.title(f"San Francisco Temperature ({condition})")
plt.grid(True, alpha=0.3)
plt.show()

print(f"Weather data retrieved: {temp}°F, {condition}")
print(f"Plot generated successfully with {len(temps)} data points")'

    local tools='[
        {
            "name": "get_weather",
            "description": "Get weather for a city. Returns dict with temperature and condition.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "City name"}
                },
                "required": ["city"]
            }
        }
    ]'
    
    run_test "$code" "$tools" "Matplotlib + Tool Calls Test"
}

# Test: Bash PTC - simple echo (no tool calls)
test_bash_echo() {
    local code='echo "hello from bash"
echo "another line"'
    local tools='[
        {
            "name": "get_weather",
            "description": "Unused.",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
        }
    ]'
    run_test "$code" "$tools" "Bash: Echo (no tool calls)" "bash"
}

# Test: Bash PTC - one tool call captured via command substitution
test_bash_one_call() {
    local code='result=$(get_weather '"'"'{"city":"San Francisco"}'"'"')
echo "Weather result: $result"
temp=$(printf "%s" "$result" | jq -r ".temperature")
echo "Temperature: $temp"'
    local tools='[
        {
            "name": "get_weather",
            "description": "Get weather for a city.",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
        }
    ]'
    run_test "$code" "$tools" "Bash: One tool call" "bash"
}

# Test: Bash PTC - cached call across two continuations
test_bash_multi() {
    local code='sf=$(get_weather '"'"'{"city":"San Francisco"}'"'"')
ny=$(get_weather '"'"'{"city":"New York"}'"'"')
echo "SF: $sf"
echo "NY: $ny"'
    local tools='[
        {
            "name": "get_weather",
            "description": "Get weather for a city.",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
        }
    ]'
    run_test "$code" "$tools" "Bash: Multiple tool calls" "bash"
}

# Test: Bash PTC - parallel bare tool calls emit one batch
test_bash_parallel() {
    echo ""
    echo "============================================================================="
    log_info "Starting: Bash - Parallel Tool Calls"
    echo "============================================================================="

    local service_id="45886e06-932b-4cff-bb49-3f7281d80717"
    local code='list_databases_mcp_ClickHouse '"'"'{"serviceId":"45886e06-932b-4cff-bb49-3f7281d80717"}'"'"' &
list_tables_mcp_ClickHouse '"'"'{"serviceId":"45886e06-932b-4cff-bb49-3f7281d80717","database":"default"}'"'"' &
wait
echo "parallel done"'
    local tools='[
        {
            "name": "list_databases_mcp_ClickHouse",
            "description": "List databases for a ClickHouse service.",
            "parameters": {
                "type": "object",
                "properties": {"serviceId": {"type": "string"}},
                "required": ["serviceId"]
            }
        },
        {
            "name": "list_tables_mcp_ClickHouse",
            "description": "List tables for a ClickHouse service database.",
            "parameters": {
                "type": "object",
                "properties": {
                    "serviceId": {"type": "string"},
                    "database": {"type": "string"}
                },
                "required": ["serviceId", "database"]
            }
        }
    ]'

    local response
    response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "{\"code\": $(echo "$code" | jq -Rs .), \"tools\": $tools, \"language\": \"bash\"}")
    echo "$response" | jq '.' 2>/dev/null || echo "$response"

    local status
    status=$(echo "$response" | jq -r '.status // "unknown"')
    local continuation_token
    continuation_token=$(echo "$response" | jq -r '.continuation_token // empty')
    local tool_call_count
    tool_call_count=$(echo "$response" | jq '.tool_calls | length')

    if [ "$status" != "tool_call_required" ] || [ "$tool_call_count" -ne 2 ] || [ -z "$continuation_token" ]; then
        log_error "Expected one tool_call_required batch with 2 calls, got status=$status count=$tool_call_count"
        return 1
    fi
    if ! echo "$response" | jq -e '
        ([.tool_calls[].name] | index("list_databases_mcp_ClickHouse") != null)
        and ([.tool_calls[].name] | index("list_tables_mcp_ClickHouse") != null)
    ' >/dev/null; then
        log_error "Expected both ClickHouse MCP tool names in the first batch"
        return 1
    fi
    if ! echo "$response" | jq -e --arg service_id "$service_id" '
        [.tool_calls[].input.serviceId] | all(. == $service_id)
    ' >/dev/null; then
        log_error "Expected both tool inputs to preserve serviceId"
        return 1
    fi

    local tool_results
    tool_results=$(process_tool_calls "$(echo "$response" | jq '.tool_calls')")
    log_info "Tool results: $(echo "$tool_results" | jq -c '.')"

    response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "{\"continuation_token\": \"$continuation_token\", \"tool_results\": $tool_results}")
    echo "$response" | jq '.' 2>/dev/null || echo "$response"

    status=$(echo "$response" | jq -r '.status // "unknown"')
    local stdout
    stdout=$(echo "$response" | jq -r '.stdout // ""')
    if [ "$status" = "completed" ] &&
        echo "$stdout" | grep -q '"databases"' &&
        echo "$stdout" | grep -q '"tables"' &&
        echo "$stdout" | grep -q 'parallel done'; then
        log_success "Bash parallel tool calls completed from a single pending batch"
    else
        log_error "Expected completed response with database/table outputs. Got status=$status stdout='$stdout'"
        return 1
    fi
    echo "============================================================================="
}

# Test: Bash PTC - tool returns error -> non-zero exit with stderr
test_bash_error_tool() {
    echo ""
    echo "============================================================================="
    log_info "Starting: Bash - Tool Error Propagation"
    echo "============================================================================="

    local code='result=$(get_weather '"'"'{"city":"Nowhere"}'"'"')
echo "UNREACHABLE: $result"'
    local tools='[{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]'

    local response
    response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{\"code\": $(echo "$code" | jq -Rs .), \"tools\": $tools, \"language\": \"bash\"}")
    echo "$response" | jq '.' 2>/dev/null || echo "$response"

    local continuation_token
    continuation_token=$(echo "$response" | jq -r '.continuation_token // empty')
    local call_id
    call_id=$(echo "$response" | jq -r '.tool_calls[0].id // empty')

    if [ -z "$continuation_token" ] || [ -z "$call_id" ]; then
        log_error "Expected tool_call_required with a call_id, got: $response"
        return 1
    fi

    local error_results
    error_results=$(jq -n --arg id "$call_id" \
        '[{"call_id": $id, "result": null, "is_error": true, "error_message": "city not found"}]')

    response=$(curl -s -X POST "$SERVICE_URL/v1/exec/programmatic" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $BEARER_TOKEN" \
        -d "{\"continuation_token\": \"$continuation_token\", \"tool_results\": $error_results}")
    echo "$response" | jq '.'

    local status
    status=$(echo "$response" | jq -r '.status // "unknown"')
    local stderr
    stderr=$(echo "$response" | jq -r '.stderr // ""')
    local stdout
    stdout=$(echo "$response" | jq -r '.stdout // ""')

    if [ "$status" = "error" ] && echo "$stderr" | grep -q 'city not found' && ! echo "$stdout" | grep -q UNREACHABLE; then
        log_success "Bash tool error surfaced as non-zero exit with stderr"
    else
        log_error "Expected status=error with stderr containing 'city not found'. Got status=$status stderr='$stderr' stdout='$stdout'"
        return 1
    fi
    echo "============================================================================="
}

# =============================================================================
# Main
# =============================================================================

echo ""
echo "============================================================================="
echo "  PROGRAMMATIC TOOL CALLING TEST SUITE"
echo "============================================================================="
echo "  Service URL: $SERVICE_URL"
echo "  bearer token: ${BEARER_TOKEN:0:10}..."
echo "============================================================================="

# Check dependencies
if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed. Install with: apt install jq"
    exit 1
fi

if ! command -v curl &> /dev/null; then
    log_error "curl is required but not installed."
    exit 1
fi

# Run specific test or all tests
case "${1:-all}" in
    simple)
        test_simple
        ;;
    multiple)
        test_multiple
        ;;
    loop)
        test_loop
        ;;
    calculator)
        test_calculator
        ;;
    chained)
        test_chained
        ;;
    async)
        test_async
        ;;
    matplotlib)
        test_matplotlib
        ;;
    no_calls)
        test_no_calls
        ;;
    error_tool)
        test_error_tool
        ;;
    expired_token)
        test_expired_token
        ;;
    bash_echo)
        test_bash_echo
        ;;
    bash_one_call)
        test_bash_one_call
        ;;
    bash_multi)
        test_bash_multi
        ;;
    bash_parallel)
        test_bash_parallel
        ;;
    bash_error_tool)
        test_bash_error_tool
        ;;
    bash)
        test_bash_echo
        test_bash_one_call
        test_bash_multi
        test_bash_parallel
        test_bash_error_tool
        ;;
    all)
        test_no_calls
        test_simple
        test_multiple
        test_loop
        test_calculator
        test_chained
        test_async
        test_error_tool
        test_expired_token
        test_bash_echo
        test_bash_one_call
        test_bash_multi
        test_bash_parallel
        test_bash_error_tool
        ;;
    *)
        echo "Usage: $0 [simple|multiple|loop|calculator|chained|async|matplotlib|no_calls|error_tool|expired_token|bash_echo|bash_one_call|bash_multi|bash_parallel|bash_error_tool|bash|all]"
        echo ""
        echo "Tests:"
        echo "  simple         - Single tool call (get_weather)"
        echo "  multiple       - Multiple sequential calls (get_team_members)"
        echo "  loop           - Tool calls in a loop (get_team + get_expenses for each)"
        echo "  calculator     - Simple calculator tool"
        echo "  chained        - Chained dependencies (output of one feeds into next)"
        echo "  async          - Parallel execution with asyncio.gather()"
        echo "  matplotlib     - Matplotlib + tool calls combined"
        echo "  no_calls       - User code issues zero tool calls (fast path)"
        echo "  error_tool     - Tool returns is_error=true, verifies ToolExecutionError propagates"
        echo "  expired_token  - Unknown/expired continuation token yields HTTP 404"
        echo "  bash_echo      - Bash script that issues zero tool calls"
        echo "  bash_one_call  - Bash with a single tool call"
        echo "  bash_multi     - Bash with multiple sequential tool calls, replayed"
        echo "  bash_parallel  - Bash with two backgrounded tool calls joined by wait"
        echo "  bash_error_tool - Bash tool returns an error, verifies non-zero exit + stderr"
        echo "  bash           - Run all bash-related tests"
        echo "  all            - Run Python and bash tests"
        echo ""
        echo "Environment variables:"
        echo "  SERVICE_URL  - Service API URL (default: http://localhost:3112)"
        echo "  BEARER_TOKEN      - bearer token for authentication"
        exit 1
        ;;
esac

log_success "All tests completed!"
