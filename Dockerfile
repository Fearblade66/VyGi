# VyGi web server: the VyGi UI in a browser, for running on a home server.
# Build:  docker build -t vygi .
# Run:    see docker-compose.yml and the README's "Run VyGi in Docker" section.

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
RUN npx vite build

FROM rust:1-bookworm AS server
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src/src-tauri
COPY src-tauri/ ./
RUN cargo build --release --locked --no-default-features --features server --bin vygi-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /data vygi \
    && mkdir -p /data && chown vygi /data
COPY --from=server /src/src-tauri/target/release/vygi-server /app/vygi-server
COPY --from=web /src/dist /app/web
USER vygi
ENV VYGI_DATA=/data VYGI_WEB=/app/web
VOLUME /data
EXPOSE 8443
ENTRYPOINT ["/app/vygi-server"]
