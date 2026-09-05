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
COPY src/ src/

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

# Writable data directory (mount point)
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data

EXPOSE 20128

ENTRYPOINT ["/app/derouter"]
