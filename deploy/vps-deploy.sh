#!/bin/sh
set -eu

umask 077
export AWS_PAGER=""

TEMP_SECRET_FILE=

cleanup() {
  if [ -n "$TEMP_SECRET_FILE" ]; then
    rm -f "$TEMP_SECRET_FILE"
  fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fail() {
  printf '%s\n' "vps-deploy: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_variable() {
  eval "variable_value=\${$1:-}"
  [ -n "$variable_value" ] || fail "required environment variable is unset: $1"
  unset variable_value
}

fetch_parameter() {
  parameter_name="$1"
  destination="$2"
  temporary_file=$(mktemp "${SECRETS_DIR}/.secret.XXXXXX")
  TEMP_SECRET_FILE=$temporary_file
  if ! aws ssm get-parameter \
    --name "$parameter_name" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text > "$temporary_file" 2>/dev/null; then
    rm -f "$temporary_file"
    fail "AWS SSM could not provide a required secret"
  fi
  [ -s "$temporary_file" ] || {
    rm -f "$temporary_file"
    fail "AWS SSM returned an empty secret"
  }
  # The parent directory is root-only. Mode 0444 lets Compose bind-mount the
  # file into non-root containers without making it reachable by host users.
  chmod 0444 "$temporary_file"
  mv -f "$temporary_file" "$destination"
  TEMP_SECRET_FILE=
  unset parameter_name destination temporary_file
}

materialize_optional_parameter() {
  parameter_name="$1"
  destination="$2"
  if [ -n "$parameter_name" ]; then
    fetch_parameter "$parameter_name" "$destination"
    return
  fi
  # A one-time activation helper may have materialized this optional secret
  # directly into the root-only secrets directory. Preserve a non-empty value
  # when no Parameter Store name is configured.
  if [ -s "$destination" ]; then
    chmod 0444 "$destination"
    return
  fi
  temporary_file=$(mktemp "${SECRETS_DIR}/.secret.XXXXXX")
  chmod 0444 "$temporary_file"
  mv -f "$temporary_file" "$destination"
  unset parameter_name destination temporary_file
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$APP_DIR/docker-compose.yml" "$@"
}

[ "$(id -u)" -eq 0 ] || fail "run this script as root from an authenticated SSM session"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
ENV_FILE=${CROWDQUEST_ENV_FILE:-/etc/crowdquest/production.env}
SECRETS_DIR=${CROWDQUEST_SECRETS_DIR:-/var/lib/crowdquest/secrets}
CALLER_IMAGE_TAG=${CROWDQUEST_IMAGE_TAG:-}

require_command aws
require_command curl
require_command docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
[ -f "$ENV_FILE" ] || fail "deployment environment file does not exist"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# A release operator may pin the image tag to the reviewed Git commit. Keep
# that explicit value even when the persistent environment still names the
# previous release; the environment remains the fallback for manual runs.
if [ -n "$CALLER_IMAGE_TAG" ]; then
  CROWDQUEST_IMAGE_TAG=$CALLER_IMAGE_TAG
  export CROWDQUEST_IMAGE_TAG
fi
unset CALLER_IMAGE_TAG

require_variable SSM_POSTGRES_PASSWORD_PARAM
require_variable SSM_ADMIN_TOKEN_PARAM

install -d -m 0700 -o root -g root "$SECRETS_DIR"
fetch_parameter "$SSM_POSTGRES_PASSWORD_PARAM" "$SECRETS_DIR/postgres_password"
fetch_parameter "$SSM_ADMIN_TOKEN_PARAM" "$SECRETS_DIR/admin_token"
materialize_optional_parameter "${SSM_TXLINE_API_TOKEN_PARAM:-}" "$SECRETS_DIR/txline_api_token"
materialize_optional_parameter "${SSM_COINBASE_AGENT_TOKEN_PARAM:-}" "$SECRETS_DIR/coinbase_agent_token"

compose config >/dev/null
compose build --pull
compose up -d --remove-orphans

gateway_binding=$(compose port gateway 8080)
case "$gateway_binding" in
  127.0.0.1:*) ;;
  *) fail "gateway is not bound exclusively to loopback" ;;
esac

health_url="http://${gateway_binding}/healthz"
attempt=0
until curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || fail "deployment did not become healthy"
  sleep 2
done

compose ps
printf '%s\n' "CrowdQuest containers are healthy on the loopback gateway."
