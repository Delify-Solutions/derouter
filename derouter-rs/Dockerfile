# --- Stage 1: Build ---
FROM rust:1.88-slim AS builder

WORKDIR /app

# Install needed build deps (e.g. for rustls)
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better layer caching
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src/ src/
COPY templates/ templates/
COPY static/ static/

# Build release binary
RUN cargo build --release

# --- Stage 2: Runtime ---
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the release binary
COPY --from=builder /app/target/release/derouter /app/derouter

# Copy static assets (htmx.min.js, alpine.min.js, app.css)
COPY --from=builder /app/static/ /app/static/

# Copy templates (Askama compiles at build time, but keep for reference)
COPY --from=builder /app/templates/ /app/templates/

# Writable data directory (mount point)
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data

EXPOSE 20128

ENTRYPOINT ["/app/derouter"]
