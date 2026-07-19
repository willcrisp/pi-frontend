#!/bin/sh
# Joins the tailnet (userspace networking - no /dev/net/tun needed, so this
# works on Railway) then execs the bridge server, which relays the pi RPC
# session over SSH to SSH_TARGET instead of spawning pi locally.
set -eu

: "${TS_AUTHKEY:?set TS_AUTHKEY (a reusable, ephemeral Tailscale auth key)}"
: "${SSH_TARGET:?set SSH_TARGET, e.g. you@home-machine.your-tailnet.ts.net}"
: "${REMOTE_CWD:?set REMOTE_CWD, the project directory on the remote machine}"

mkdir -p /var/lib/tailscale /var/run/tailscale
tailscaled \
    --state=/var/lib/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    --tun=userspace-networking &

for i in $(seq 1 30); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
done

tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="${TS_AUTHKEY}" \
    --hostname="${TS_HOSTNAME:-pi-web-railway}"

# If the home machine has Tailscale SSH enabled (`tailscale up --ssh` there),
# no key is needed at all - skip SSH_PRIVATE_KEY entirely and leave this unset.
if [ -n "${SSH_PRIVATE_KEY:-}" ] && [ -z "${SSH_IDENTITY_PATH:-}" ]; then
    mkdir -p /root/.ssh
    printf '%s\n' "${SSH_PRIVATE_KEY}" > /root/.ssh/id_relay
    chmod 600 /root/.ssh/id_relay
    SSH_IDENTITY_PATH=/root/.ssh/id_relay
fi

set -- --port "${SERVER_PORT:-3210}" --web-dir /app/web/dist \
    --ssh "${SSH_TARGET}" --cwd "${REMOTE_CWD}"

if [ -n "${SSH_IDENTITY_PATH:-}" ]; then
    set -- "$@" --ssh-identity "${SSH_IDENTITY_PATH}"
fi

if [ -n "${PI_EXTRA_ARGS:-}" ]; then
    set -- "$@" -- ${PI_EXTRA_ARGS}
fi

exec /app/server "$@"
