#!/usr/bin/env bash
#
# Manual black-box integration test for the FX Exchange API.
#
# Exercises every major endpoint and a broad set of edge cases against a REAL
# running stack (Postgres + Redis + RabbitMQ + the Nest app), driving it purely
# over HTTP the way a client would. It is the hand-runnable companion to the
# Jest e2e suite: no test framework, no DI overrides, just curl + assertions.
#
# By default it is self-contained: it brings up docker infra, builds and boots
# the app (NODE_ENV=development so the OTP is emitted to the app log, the only
# black-box way to complete the auth flow), runs the suite, then tears down
# whatever it started.
#
# Usage:
#   test/manual-integration.sh                 # self-contained: boot infra+app, test, teardown
#   test/manual-integration.sh --no-boot       # test an app already running at BASE_URL
#   KEEP_UP=1 test/manual-integration.sh       # leave infra+app running afterwards
#
# Env:
#   BASE_URL      (default http://localhost:3000)
#   PORT          (default 3000)             port to boot the app on
#   DB_CONTAINER  (default fx-exchange-db)   compose Postgres container name
#   DB_PSQL       (default: docker exec into DB_CONTAINER)  psql invocation used
#                 to mark users verified; override for --no-boot against a
#                 non-compose database.
#
# Exit code is 0 only if every assertion passed.
#
# Rate limits: /auth/register and /auth/signin are throttled at 5/min per IP by
# an @Throttle decorator that env cannot override. Every auth call therefore
# goes through a 429-aware retry that waits out the window, and the suite uses a
# small REUSED user pool (created once) with delta-based balance assertions
# rather than minting a user per case. This keeps the run correct; it can still
# pause for ~60s at a time when the throttle window fills.
#
# Email verification: rather than depend on the async mail worker and scrape the
# OTP from logs (flaky timing), we mark the user verified directly in Postgres
# (UPDATE users SET "isVerified" = true) -- exactly what /auth/verify does. This
# also saves one throttled call per user. Requires DB access; in the default
# self-contained mode that's `docker exec` into the compose Postgres container.

set -uo pipefail

# --- configuration -----------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://localhost:3000}"
API="${BASE_URL}/api/v1"
PORT="${PORT:-3000}"
PASSWORD='Password123!'
QUOTE_TTL=5                       # FX_QUOTE_TTL_SECONDS the app is booted with
BOOT=1
[[ "${1:-}" == "--no-boot" ]] && BOOT=0

# How to reach Postgres for the direct "mark verified" UPDATE.
#   - self-contained mode: exec into the compose container (default below)
#   - --no-boot mode: set DB_PSQL to a host psql invocation, e.g.
#       DB_PSQL='psql postgresql://postgres:postgres@localhost:5432/fx_exchange'
DB_CONTAINER="${DB_CONTAINER:-fx-exchange-db}"
DB_PSQL="${DB_PSQL:-docker exec -i $DB_CONTAINER psql -U postgres -d fx_exchange}"

APP_LOG="${APP_LOG:-$(mktemp -t fx-app.XXXXXX.log)}"
APP_PID=""
STARTED_INFRA=0
BODY_FILE="$(mktemp -t fx-body.XXXXXX)"

# --- output helpers (ALL narration goes to stderr so it never pollutes a -----
# --- $(...) capture; only assertion lines and the report go to stdout) --------

C_GREEN=$'\e[32m'; C_RED=$'\e[31m'; C_YELLOW=$'\e[33m'; C_BLUE=$'\e[36m'; C_OFF=$'\e[0m'
PASS_COUNT=0
FAIL_COUNT=0
FAILURES=()

section() { printf '\n%s== %s ==%s\n' "$C_BLUE" "$1" "$C_OFF" >&2; }
info()    { printf '%s· %s%s\n' "$C_YELLOW" "$1" "$C_OFF" >&2; }

# check <ok?> <description> [detail-on-fail]
check() {
  local ok="$1" desc="$2" detail="${3:-}"
  if [[ "$ok" == "1" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  %s✓%s %s\n' "$C_GREEN" "$C_OFF" "$desc" >&2
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("$desc")
    printf '  %s✗%s %s\n' "$C_RED" "$C_OFF" "$desc" >&2
    [[ -n "$detail" ]] && printf '      %s%s%s\n' "$C_RED" "$detail" "$C_OFF" >&2
  fi
}

# assert_status <expected> <actual> <description>
assert_status() {
  [[ "$2" == "$1" ]] && check 1 "$3" \
    || check 0 "$3" "expected HTTP $1, got $2 — body: $(head -c 300 "$BODY_FILE")"
}

# assert_contains <regex> <description> -- greps the last response body
assert_contains() {
  grep -qiE "$1" "$BODY_FILE" && check 1 "$2" \
    || check 0 "$2" "missing /$1/ in: $(head -c 300 "$BODY_FILE")"
}

# --- low-level HTTP ----------------------------------------------------------

uuid() { cat /proc/sys/kernel/random/uuid; }

# req <METHOD> <path> <body|""> [header...] -> echoes status code; body in $BODY_FILE
req() {
  local method="$1" path="$2" body="$3"; shift 3
  local -a hdrs=(); local h
  for h in "$@"; do hdrs+=(-H "$h"); done
  if [[ -n "$body" ]]; then
    curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${API}${path}" \
      -H 'Content-Type: application/json' "${hdrs[@]}" -d "$body"
  else
    curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$method" "${API}${path}" "${hdrs[@]}"
  fi
}

# auth_req: like req, but waits out a 429 from the auth throttler and retries,
# so the suite never fails on rate limits. Only the status code reaches stdout.
auth_req() {
  local code
  for _ in 1 2 3 4; do
    code="$(req "$@")"
    if [[ "$code" == "429" ]]; then
      info "auth throttled (429); waiting 61s for the rate-limit window to reset…"
      sleep 61
      continue
    fi
    break
  done
  echo "$code"
}

# json_field <key> -- first matching scalar anywhere in the response (recursive
# descent finds it whether at the top level or inside the `data` envelope).
json_field() {
  jq -r --arg k "$1" '[.. | objects | select(has($k)) | .[$k]] | .[0] // empty' \
    "$BODY_FILE" 2>/dev/null
}

# verify_user <email> -- flip isVerified directly in Postgres (what /auth/verify
# does), avoiding the async mail worker entirely. Echoes the affected row count.
verify_user() {
  $DB_PSQL -tA -c \
    "UPDATE users SET \"isVerified\" = true WHERE email = '$1';" 2>/dev/null \
    | grep -oE 'UPDATE [0-9]+' | grep -oE '[0-9]+'
}

# make_user -- register, mark verified in the DB, then signin. Echoes
# "<token> <email>", or "ERR <reason>" on failure. Throttled calls retry on 429.
make_user() {
  local email code token affected
  email="user-$(uuid)@example.com"
  code="$(auth_req POST /auth/register "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}")"
  [[ "$code" == "202" ]] || { echo "ERR register-$code"; return 1; }
  affected="$(verify_user "$email")"
  [[ "$affected" == "1" ]] || { echo "ERR verify-db-${affected:-0}"; return 1; }
  code="$(auth_req POST /auth/signin "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}")"
  [[ "$code" == "200" ]] || { echo "ERR signin-$code"; return 1; }
  token="$(json_field access_token)"
  [[ -n "$token" ]] || { echo "ERR no-token"; return 1; }
  echo "$token $email"
}

# fund <token> <currency> <amount> -> echoes status code
fund() {
  req POST /wallet/fund "{\"currency\":\"$2\",\"amount\":$3}" \
    "Authorization: Bearer $1" "x-idempotency-key: $(uuid)"
}

# balance_of <token> <currency> -- echoes balanceSubunits for that currency, or 0
balance_of() {
  req GET /wallet "" "Authorization: Bearer $1" >/dev/null
  jq -r --arg c "$2" \
    '(.data.balances // [])[] | select(.currency==$c) | .balanceSubunits' \
    "$BODY_FILE" 2>/dev/null | head -1 | grep . || echo 0
}

# quote_for <token> <from> <to> <amountInSubunits> -- echoes "<quoteId> <amountOut>"
quote_for() {
  req POST /fx/quotes \
    "{\"fromCurrency\":\"$2\",\"toCurrency\":\"$3\",\"amountInSubunits\":$4}" \
    "Authorization: Bearer $1" >/dev/null
  echo "$(json_field id) $(json_field amountOutSubunits)"
}

# --- lifecycle ---------------------------------------------------------------

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    if [[ "${KEEP_UP:-0}" == "1" ]]; then
      info "KEEP_UP=1 — leaving app running (pid $APP_PID), log: $APP_LOG"
    else
      info "stopping app (pid $APP_PID)"
      kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
    fi
  fi
  if [[ "$STARTED_INFRA" == "1" && "${KEEP_UP:-0}" != "1" ]]; then
    info "stopping docker infra"
    (cd "$ROOT_DIR" && docker compose down >/dev/null 2>&1)
  fi
  rm -f "$BODY_FILE"
}
trap cleanup EXIT

wait_for_health() {
  for _ in $(seq 1 60); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "${API}/health")" == "200" ]] && return 0
    sleep 1
  done
  return 1
}

boot() {
  section "Boot"
  # Single-instance guard: the compose project is shared, so a second
  # self-contained run would tear infra down under the first. Hold an exclusive
  # lock for the lifetime of this process; bail if another run holds it.
  exec 9>"/tmp/fx-manual-integration.lock"
  if ! flock -n 9; then
    echo "another self-contained run holds the infra lock; aborting" >&2
    echo "(use --no-boot against a shared app, or wait for it to finish)" >&2
    exit 1
  fi

  info "starting docker infra (postgres, redis, rabbitmq)"
  (cd "$ROOT_DIR" && docker compose up -d >/dev/null 2>&1) \
    && STARTED_INFRA=1 || { echo "docker compose up failed" >&2; exit 1; }

  info "waiting for postgres"
  for _ in $(seq 1 30); do
    docker exec fx-exchange-db pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done

  info "building app (nest build)"
  (cd "$ROOT_DIR" && npm run build >/dev/null 2>&1) || { echo "build failed" >&2; exit 1; }

  info "starting app on port $PORT (NODE_ENV=development, quote TTL ${QUOTE_TTL}s), log: $APP_LOG"
  ( cd "$ROOT_DIR" && RATE_LIMIT_LIMIT=100000 NODE_ENV=development PORT="$PORT" \
      FX_QUOTE_TTL_SECONDS="$QUOTE_TTL" node dist/src/main.js >"$APP_LOG" 2>&1 ) &
  APP_PID=$!

  info "waiting for /health"
  wait_for_health || { echo "app did not become healthy; see $APP_LOG" >&2; tail -30 "$APP_LOG" >&2; exit 1; }
  check 1 "app is healthy (GET /health -> 200)"
}

# =============================================================================
# User pool -- created once, reused everywhere. Keeps us within the auth
# throttle budget. Balance assertions are delta-based so reuse is safe.
# =============================================================================

declare -A TOK   # name -> bearer token
declare -A MAIL  # name -> email

new_pool_user() {
  local name="$1" out
  out="$(make_user)"
  if [[ "$out" == ERR* || -z "$out" ]]; then
    check 0 "create pool user '$name'" "make_user -> $out"
    return 1
  fi
  TOK[$name]="${out%% *}"
  MAIL[$name]="${out##* }"
  check 1 "create pool user '$name'"
}

create_pool() {
  section "User pool"
  for u in primary conv trade thief misc poor; do
    new_pool_user "$u" || return 1
  done
}

# warm_fx -- hit GET /fx/rates until it returns 200, seeding the no-expiry
# fallback cache. The very first FX call hits the live upstream provider; if it
# flakes before the fallback is populated, FX endpoints 500. Doing it once here
# (with retries) keeps every later rate-dependent assertion deterministic.
warm_fx() {
  section "FX warm-up"
  local code
  for attempt in $(seq 1 5); do
    code="$(req GET /fx/rates "" "Authorization: Bearer ${TOK[primary]}")"
    [[ "$code" == "200" ]] && { check 1 "FX rates reachable; fallback cache seeded"; return 0; }
    info "FX rates not ready (HTTP $code), retry $attempt/5…"
    sleep 2
  done
  check 0 "FX rates reachable; fallback cache seeded" "last HTTP $code"
  return 1
}

# =============================================================================
# Suite
# =============================================================================

run_auth_rejections() {
  section "Auth: rejection paths"
  local code dup unv
  [[ "${TOK[primary]:-}" =~ \..+\. ]] && check 1 "pool token looks like a JWT" \
    || check 0 "pool token looks like a JWT"

  dup="dup-$(uuid)@example.com"
  code="$(auth_req POST /auth/register "{\"email\":\"$dup\",\"password\":\"$PASSWORD\"}")"
  assert_status 202 "$code" "first registration accepted (202)"
  code="$(auth_req POST /auth/register "{\"email\":\"$dup\",\"password\":\"$PASSWORD\"}")"
  assert_status 400 "$code" "duplicate registration rejected (400)"
  assert_contains "exist|registered|already" "duplicate error message is meaningful"

  code="$(auth_req POST /auth/register "{\"email\":\"weak-$(uuid)@example.com\",\"password\":\"weakpass\"}")"
  assert_status 400 "$code" "weak password rejected (400)"
  code="$(auth_req POST /auth/register '{"email":"not-an-email","password":"'"$PASSWORD"'"}')"
  assert_status 400 "$code" "malformed email rejected (400)"
  code="$(auth_req POST /auth/register '{}')"
  assert_status 400 "$code" "missing fields rejected (400)"

  code="$(req POST /auth/verify "{\"email\":\"${MAIL[primary]}\",\"otp\":\"000000\"}")"
  assert_status 400 "$code" "wrong OTP rejected (400)"
  code="$(req POST /auth/verify '{"email":"whoever@example.com","otp":"123"}')"
  assert_status 400 "$code" "malformed OTP rejected (400)"

  code="$(auth_req POST /auth/signin "{\"email\":\"nobody-$(uuid)@example.com\",\"password\":\"$PASSWORD\"}")"
  assert_status 400 "$code" "signin with unknown email rejected (400)"
  code="$(auth_req POST /auth/signin "{\"email\":\"${MAIL[primary]}\",\"password\":\"WrongPass123!\"}")"
  assert_status 400 "$code" "signin with wrong password rejected (400)"

  unv="unverified-$(uuid)@example.com"
  auth_req POST /auth/register "{\"email\":\"$unv\",\"password\":\"$PASSWORD\"}" >/dev/null
  code="$(auth_req POST /auth/signin "{\"email\":\"$unv\",\"password\":\"$PASSWORD\"}")"
  assert_status 400 "$code" "signin for unverified account rejected (400)"

  code="$(req GET /wallet "")"
  assert_status 401 "$code" "unauthenticated wallet access rejected (401)"
  code="$(req GET /wallet "" 'Authorization: NotBearer something')"
  assert_status 401 "$code" "malformed bearer token rejected (401)"
  code="$(req GET /wallet "" 'Authorization: Bearer not.a.jwt')"
  assert_status 401 "$code" "garbage JWT rejected (401)"
}

run_funding() {
  section "Wallet funding"
  local t="${TOK[primary]}" code before after key j1 j2
  req GET /wallet "" "Authorization: Bearer $t" >/dev/null

  # 'poor' is never funded -> its wallet is empty.
  req GET /wallet "" "Authorization: Bearer ${TOK[poor]}" >/dev/null
  grep -qE '"balances":\[\]' "$BODY_FILE" && check 1 "an unfunded wallet has no balances" \
    || check 0 "an unfunded wallet has no balances" "$(head -c 200 "$BODY_FILE")"

  before="$(balance_of "$t" NGN)"
  code="$(fund "$t" NGN 250000)"
  assert_status 200 "$code" "fund 250000 NGN succeeds (200)"
  assert_contains "SUCCESS" "funding status is SUCCESS"
  after="$(balance_of "$t" NGN)"
  [[ $((after - before)) == 250000 ]] && check 1 "NGN balance increased by exactly 250000" \
    || check 0 "NGN balance increased by exactly 250000" "delta $((after - before))"

  code="$(req POST /wallet/fund '{"currency":"XYZ","amount":100}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "unsupported currency rejected (400)"
  code="$(req POST /wallet/fund '{"currency":"ngn","amount":100}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "lowercase currency rejected (400)"
  for amt in 0 -5 1.5; do
    code="$(req POST /wallet/fund "{\"currency\":\"NGN\",\"amount\":$amt}" "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
    assert_status 400 "$code" "invalid amount ($amt) rejected (400)"
  done
  code="$(req POST /wallet/fund '{"currency":"NGN","amount":100000000001}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "amount over maximum rejected (400)"
  code="$(req POST /wallet/fund '{"currency":"NGN","amount":100}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "missing idempotency key rejected (400)"
  code="$(req POST /wallet/fund '{"currency":"NGN","amount":100}' "Authorization: Bearer $t" "x-idempotency-key:    ")"
  assert_status 400 "$code" "whitespace-only idempotency key rejected (400)"
  code="$(req POST /wallet/fund '{"currency":"NGN","amount":100}' "Authorization: Bearer $t" "x-idempotency-key: $(printf 'k%.0s' {1..256})")"
  assert_status 400 "$code" "over-long idempotency key rejected (400)"

  # Idempotent replay: same key, same payload, twice -> one credit, same journal.
  before="$(balance_of "$t" NGN)"
  key="$(uuid)"
  req POST /wallet/fund '{"currency":"NGN","amount":12345}' "Authorization: Bearer $t" "x-idempotency-key: $key" >/dev/null
  j1="$(json_field id)"
  req POST /wallet/fund '{"currency":"NGN","amount":12345}' "Authorization: Bearer $t" "x-idempotency-key: $key" >/dev/null
  j2="$(json_field id)"
  [[ -n "$j1" && "$j1" == "$j2" ]] && check 1 "idempotent replay returns the same journal id" \
    || check 0 "idempotent replay returns the same journal id" "j1=$j1 j2=$j2"
  after="$(balance_of "$t" NGN)"
  [[ $((after - before)) == 12345 ]] && check 1 "idempotent replay credits exactly once (delta 12345)" \
    || check 0 "idempotent replay credits exactly once" "delta $((after - before))"
}

run_convert() {
  section "Wallet convert (legacy mid-rate)"
  local t="${TOK[conv]}" code nb ub
  fund "$t" NGN 5000000 >/dev/null
  code="$(req POST /wallet/convert '{"fromCurrency":"NGN","toCurrency":"NGN","amount":100}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "same-currency convert rejected (400)"
  code="$(req POST /wallet/convert '{"fromCurrency":"XYZ","toCurrency":"USD","amount":100}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "unsupported currency convert rejected (400)"
  code="$(req POST /wallet/convert '{"fromCurrency":"NGN","toCurrency":"USD","amount":999999999}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "convert over balance rejected (400)"
  assert_contains "Insufficient NGN balance" "insufficient-balance message present"
  code="$(req POST /wallet/convert '{"fromCurrency":"NGN","toCurrency":"USD","amount":1}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 400 "$code" "convert rounding to zero rejected (400)"

  nb="$(balance_of "$t" NGN)"; ub="$(balance_of "$t" USD)"
  code="$(req POST /wallet/convert '{"fromCurrency":"NGN","toCurrency":"USD","amount":200000}' "Authorization: Bearer $t" "x-idempotency-key: $(uuid)")"
  assert_status 200 "$code" "valid convert succeeds (200)"
  assert_contains "SUCCESS" "convert status is SUCCESS"
  local nb2 ub2; nb2="$(balance_of "$t" NGN)"; ub2="$(balance_of "$t" USD)"
  [[ $((nb - nb2)) == 200000 ]] && check 1 "convert debited NGN by 200000" \
    || check 0 "convert debited NGN by 200000" "delta $((nb - nb2))"
  [[ $((ub2 - ub)) -gt 0 ]] && check 1 "convert credited some USD" \
    || check 0 "convert credited some USD" "delta $((ub2 - ub))"
}

run_fx() {
  section "FX rates and quotes"
  local t="${TOK[primary]}" code qBid qMid qAsk qEff
  code="$(req GET /fx/rates "" "Authorization: Bearer $t")"
  assert_status 200 "$code" "GET /fx/rates returns rates (200)"
  assert_contains '"version"' "rates payload carries a version"
  code="$(req GET /fx/rates "")"
  assert_status 401 "$code" "GET /fx/rates requires auth (401)"

  code="$(req POST /fx/quotes '{"fromCurrency":"NGN","toCurrency":"USD","amountInSubunits":1000000}' "Authorization: Bearer $t")"
  assert_status 201 "$code" "POST /fx/quotes returns a quote (201)"
  qBid="$(json_field bid)"; qMid="$(json_field midRate)"; qAsk="$(json_field ask)"; qEff="$(json_field effectiveRate)"
  awk "BEGIN{exit !($qBid < $qMid && $qAsk > $qMid)}" \
    && check 1 "spread applied (bid < mid < ask)" \
    || check 0 "spread applied (bid < mid < ask)" "bid=$qBid mid=$qMid ask=$qAsk"
  [[ "$qEff" == "$qBid" ]] && check 1 "seller gets the bid side (effectiveRate == bid)" \
    || check 0 "seller gets the bid side (effectiveRate == bid)" "eff=$qEff bid=$qBid"

  code="$(req POST /fx/quotes '{"fromCurrency":"NGN","toCurrency":"NGN","amountInSubunits":1000}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "same-currency quote rejected (400)"
  code="$(req POST /fx/quotes '{"fromCurrency":"XYZ","toCurrency":"USD","amountInSubunits":1000}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "unsupported-currency quote rejected (400)"
  for amt in 0 -1; do
    code="$(req POST /fx/quotes "{\"fromCurrency\":\"NGN\",\"toCurrency\":\"USD\",\"amountInSubunits\":$amt}" "Authorization: Bearer $t")"
    assert_status 400 "$code" "quote with amount $amt rejected (400)"
  done
  code="$(req POST /fx/quotes '{"fromCurrency":"NGN","toCurrency":"USD","amountInSubunits":1.5}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "non-integer quote amount rejected (400)"
  code="$(req POST /fx/quotes '{"fromCurrency":"NGN","toCurrency":"USD"}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "missing quote amount rejected (400)"
  code="$(req POST /fx/quotes '{"fromCurrency":"NGN","toCurrency":"USD","amountInSubunits":1}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "quote rounding to zero rejected (400)"
}

run_trade() {
  section "Trade execution"
  local t="${TOK[trade]}" code qid amtOut ub ub2 key first
  fund "$t" NGN 5000000 >/dev/null

  read -r qid amtOut < <(quote_for "$t" NGN USD 1000000)
  ub="$(balance_of "$t" USD)"
  code="$(req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer $t")"
  assert_status 200 "$code" "trade fills a fresh quote (200)"
  assert_contains "SUCCESS" "trade status is SUCCESS"
  ub2="$(balance_of "$t" USD)"
  [[ $((ub2 - ub)) == "$amtOut" ]] && check 1 "USD balance grew by the quote payout ($amtOut)" \
    || check 0 "USD balance grew by the quote payout" "delta $((ub2 - ub)), expected $amtOut"

  code="$(req POST /wallet/trade "{\"quoteId\":\"$(uuid)\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer $t")"
  assert_status 400 "$code" "unknown quote id rejected (400)"
  assert_contains "quote.*(expired|used|does not belong)" "unknown-quote message present"
  code="$(req POST /wallet/trade '{"quoteId":"not-a-uuid","idempotencyKey":"'"$(uuid)"'"}' "Authorization: Bearer $t")"
  assert_status 400 "$code" "malformed quote id rejected (400)"

  # Single-use: a redeemed quote cannot be traded again.
  read -r qid amtOut < <(quote_for "$t" NGN USD 100000)
  req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer $t" >/dev/null
  code="$(req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer $t")"
  assert_status 400 "$code" "re-used quote rejected (single-use) (400)"

  # Cross-user theft: thief cannot burn owner's quote; owner can still redeem it.
  read -r qid amtOut < <(quote_for "$t" NGN USD 100000)
  code="$(req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer ${TOK[thief]}")"
  assert_status 400 "$code" "another user's quote rejected for thief (400)"
  code="$(req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer $t")"
  assert_status 200 "$code" "owner can still redeem the quote the thief failed on (200)"

  # Insufficient balance: 'poor' has no NGN.
  read -r qid amtOut < <(quote_for "${TOK[poor]}" NGN USD 1000000)
  code="$(req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer ${TOK[poor]}")"
  assert_status 400 "$code" "trade with insufficient balance rejected (400)"
  assert_contains "Insufficient NGN balance" "trade insufficient-balance message present"

  # Idempotent replay short-circuits before quote consumption.
  read -r qid amtOut < <(quote_for "$t" NGN USD 100000)
  key="$(uuid)"
  req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$key\"}" "Authorization: Bearer $t" >/dev/null
  first="$(json_field id)"
  code="$(req POST /wallet/trade "{\"quoteId\":\"$(uuid)\",\"idempotencyKey\":\"$key\"}" "Authorization: Bearer $t")"
  assert_status 200 "$code" "idempotent trade replay returns cached result (200) despite bogus quote"
}

run_expiry() {
  section "Quote expiry"
  local t="${TOK[trade]}" qid amtOut code
  info "waiting out the quote TTL (~$((QUOTE_TTL + 2))s)…"
  read -r qid amtOut < <(quote_for "$t" NGN USD 50000)
  sleep $((QUOTE_TTL + 2))
  code="$(req POST /wallet/trade "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" "Authorization: Bearer $t")"
  assert_status 400 "$code" "expired quote rejected (400)"
}

run_transactions() {
  section "Transactions history & pagination"
  local t="${TOK[misc]}" code cursor n
  for i in $(seq 0 6); do fund "$t" NGN $((100 + i)) >/dev/null; done

  req GET '/transactions?limit=3' "" "Authorization: Bearer $t" >/dev/null
  n="$(jq -r '.data.items | length' "$BODY_FILE" 2>/dev/null)"
  [[ "$n" == "3" ]] && check 1 "first page returns exactly the limit (3)" \
    || check 0 "first page returns exactly the limit (3)" "got $n"
  grep -qE '"hasNextPage":true' "$BODY_FILE" && check 1 "hasNextPage is true on first page" \
    || check 0 "hasNextPage is true on first page"
  cursor="$(json_field nextCursor)"
  [[ -n "$cursor" && "$cursor" != "null" ]] && check 1 "nextCursor is present" \
    || check 0 "nextCursor is present" "got '$cursor'"
  code="$(req GET "/transactions?limit=3&cursor=$cursor" "" "Authorization: Bearer $t")"
  assert_status 200 "$code" "paginating with a cursor succeeds (200)"

  code="$(req GET '/transactions?limit=0' "" "Authorization: Bearer $t")"
  assert_status 400 "$code" "limit=0 rejected (400)"
  code="$(req GET '/transactions?limit=1000' "" "Authorization: Bearer $t")"
  assert_status 400 "$code" "limit=1000 rejected (400)"
  code="$(req GET '/transactions?cursor=not-an-iso-date' "" "Authorization: Bearer $t")"
  assert_status 400 "$code" "invalid cursor rejected (400)"

  req GET '/transactions?purpose=FUNDING' "" "Authorization: Bearer $t" >/dev/null
  if jq -e '.data.items[] | select(.purpose != "FUNDING")' "$BODY_FILE" >/dev/null 2>&1; then
    check 0 "purpose=FUNDING filter excludes non-funding journals"
  else
    check 1 "purpose=FUNDING filter excludes non-funding journals"
  fi

  # Cross-user isolation: misc and thief must never share a journal id.
  fund "${TOK[thief]}" NGN 222 >/dev/null
  req GET '/transactions?limit=50' "" "Authorization: Bearer $t" >/dev/null
  local aIds; aIds="$(jq -r '.data.items[].id' "$BODY_FILE" 2>/dev/null | sort -u)"
  req GET '/transactions?limit=50' "" "Authorization: Bearer ${TOK[thief]}" >/dev/null
  local bIds; bIds="$(jq -r '.data.items[].id' "$BODY_FILE" 2>/dev/null | sort -u)"
  if [[ -n "$aIds" ]] && comm -12 <(echo "$aIds") <(echo "$bIds") | grep -q .; then
    check 0 "transaction lists do not overlap across users"
  else
    check 1 "transaction lists do not overlap across users"
  fi
}

run_concurrency() {
  section "Concurrency & races"
  local t before after qid amtOut c1 c2 wins

  # 8 parallel funds, distinct keys -> delta is exactly 8 * 1000.
  t="${TOK[primary]}"
  before="$(balance_of "$t" NGN)"
  for _ in $(seq 1 8); do
    curl -s -o /dev/null -X POST "${API}/wallet/fund" -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $t" -H "x-idempotency-key: $(uuid)" \
      -d '{"currency":"NGN","amount":1000}' &
  done
  wait
  after="$(balance_of "$t" NGN)"
  [[ $((after - before)) == 8000 ]] && check 1 "8 parallel funds (distinct keys) add exactly 8000" \
    || check 0 "8 parallel funds (distinct keys) add exactly 8000" "delta $((after - before))"

  # 5 parallel funds, SAME key -> credited once (delta 7777).
  t="${TOK[conv]}"
  before="$(balance_of "$t" NGN)"
  local sk; sk="$(uuid)"
  for _ in $(seq 1 5); do
    curl -s -o /dev/null -X POST "${API}/wallet/fund" -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $t" -H "x-idempotency-key: $sk" \
      -d '{"currency":"NGN","amount":7777}' &
  done
  wait
  after="$(balance_of "$t" NGN)"
  [[ $((after - before)) == 7777 ]] && check 1 "5 parallel funds (same key) add exactly 7777 once" \
    || check 0 "5 parallel funds (same key) add exactly 7777 once" "delta $((after - before))"

  # Two parallel trades on one quote -> exactly one wins.
  t="${TOK[trade]}"
  fund "$t" NGN 2000000 >/dev/null
  read -r qid amtOut < <(quote_for "$t" NGN USD 1000000)
  c1="$(mktemp)"; c2="$(mktemp)"
  curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/wallet/trade" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $t" -d "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" >"$c1" &
  curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/wallet/trade" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $t" -d "{\"quoteId\":\"$qid\",\"idempotencyKey\":\"$(uuid)\"}" >"$c2" &
  wait
  wins=0
  [[ "$(cat "$c1")" == "200" ]] && wins=$((wins+1))
  [[ "$(cat "$c2")" == "200" ]] && wins=$((wins+1))
  [[ "$wins" == "1" ]] && check 1 "two parallel trades on one quote: exactly one wins" \
    || check 0 "two parallel trades on one quote: exactly one wins" "winners=$wins (codes $(cat "$c1")/$(cat "$c2"))"
  rm -f "$c1" "$c2"
}

# =============================================================================

main() {
  if [[ "$BOOT" == "1" ]]; then
    boot
  else
    section "Boot"
    info "--no-boot: testing already-running app at $BASE_URL"
    wait_for_health || { echo "no healthy app at $BASE_URL" >&2; exit 1; }
    check 1 "app is healthy (GET /health -> 200)"
    info "--no-boot: ensure DB_PSQL points at the running app's Postgres (see header)"
  fi

  create_pool || { section "Summary"; echo "  pool creation failed — aborting" >&2; exit 1; }
  warm_fx || { section "Summary"; echo "  FX warm-up failed — aborting" >&2; exit 1; }

  run_auth_rejections
  run_funding
  run_convert
  run_fx
  run_trade
  run_expiry
  run_transactions
  run_concurrency

  section "Summary"
  printf '  passed: %d   failed: %d\n' "$PASS_COUNT" "$FAIL_COUNT" >&2
  if [[ $FAIL_COUNT -gt 0 ]]; then
    printf '  failed checks:\n' >&2
    for f in "${FAILURES[@]}"; do printf '    - %s\n' "$f" >&2; done
    exit 1
  fi
  printf '  all %d checks passed\n' "$PASS_COUNT" >&2
}

main "$@"
