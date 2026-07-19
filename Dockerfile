# Thin-client image for Railway: serves the Vue frontend + the Rust bridge
# server, joins your tailnet, and relays the pi RPC session over SSH to a
# machine elsewhere on the tailnet where pi and your actual code live.
# The bridge server itself never runs pi locally in this setup.

FROM node:22-slim AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-slim-bookworm AS server-build
WORKDIR /src/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates openssh-client curl \
    && curl -fsSL https://tailscale.com/install.sh | sh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=server-build /src/server/target/release/pi-web-server /app/server
COPY --from=web-build /src/web/dist /app/web/dist
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
