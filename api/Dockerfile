# Standalone sandbox API Dockerfile (development)
# Boots the sandbox server inside a libkrun microVM with its own kernel.
# Only requires /dev/kvm on the host — no privileged mode, no capabilities.
#
# Build context: services/codeapi/api/  (for standalone) or services/codeapi/ (see note)
# Note: This Dockerfile references ../launcher/ so the build context must be
# the codeapi directory when using docker compose (context: .).

# ============================================================================
# Stage 1: Build NsJail from source
# ============================================================================
FROM buildpack-deps:bookworm AS nsjail-builder

WORKDIR /nsjail

RUN apt-get update && apt-get install -y --no-install-recommends \
    bison \
    flex \
    libprotobuf-dev \
    libnl-route-3-dev \
    protobuf-compiler \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git clone -b master --single-branch https://github.com/google/nsjail.git . \
    && git checkout dccf911fd2659e7b08ce9507c25b2b38ec2c5800

RUN make -j$(nproc)

COPY api/src/spec-guard.c /tmp/spec-guard.c
RUN gcc -O2 -static -o /usr/local/bin/spec-guard /tmp/spec-guard.c

# ============================================================================
# Stage 2: Build sandbox rootfs
# ============================================================================
FROM oven/bun:1.3.13-debian AS sandbox-build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    coreutils \
    util-linux \
    locales \
    procps \
    iptables \
    socat \
    curl \
    jq \
    poppler-utils \
    fonts-dejavu \
    fonts-liberation \
    libnl-route-3-200 \
    libprotobuf32 \
    libffi8 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && libffi=$(find /usr/lib -name 'libffi.so.8' -print -quit) \
    && { [ -n "$libffi" ] || { echo "libffi.so.8 not found" >&2; exit 1; }; } \
    && ln -sf "$libffi" "${libffi%.so.8}.so.6"

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

COPY --from=nsjail-builder /nsjail/nsjail /usr/sbin/nsjail
COPY --from=nsjail-builder /usr/local/bin/spec-guard /usr/local/bin/spec-guard
RUN chmod +x /usr/sbin/nsjail

WORKDIR /sandbox_api

COPY api/package.json ./
RUN bun install

COPY api/tsconfig.json ./
COPY api/src ./src
COPY api/config ./config

RUN bun run build

RUN mkdir -p /pkgs /tmp/sandbox

RUN find / -xdev -perm /6000 -exec chmod ug-s {} + 2>/dev/null || true

RUN rm -f /usr/bin/nsenter /usr/bin/unshare /usr/bin/chroot /usr/sbin/chroot \
         /usr/bin/perl* /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg \
         /usr/sbin/adduser /usr/sbin/useradd /usr/sbin/usermod \
         /usr/sbin/groupadd /usr/sbin/groupmod \
         /usr/bin/su \
         /usr/bin/chfn /usr/bin/chsh /usr/bin/gpasswd /usr/bin/newgrp \
         /usr/bin/passwd /usr/bin/sg \
         /usr/bin/chage /usr/bin/expiry /usr/sbin/unix_chkpwd \
    2>/dev/null || true

COPY api/src/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# ============================================================================
# Stage 3: Build the Rust launcher binary (Fedora for libkrun ABI)
# ============================================================================
FROM fedora:41 AS launcher-builder

RUN dnf install -y \
    rust cargo \
    libkrun-devel \
    gcc \
    && dnf clean all

WORKDIR /launcher
COPY launcher/Cargo.toml launcher/build.rs ./
COPY launcher/src/ ./src/

RUN cargo build --release

# ============================================================================
# Stage 4: Final launcher image (Fedora for libkrun runtime)
# ============================================================================
FROM fedora:41

RUN dnf install -y --setopt=install_weak_deps=False \
    libkrun \
    socat \
    curl \
    util-linux \
    gawk \
    findutils \
    ca-certificates \
    && dnf clean all

COPY --from=launcher-builder /launcher/target/release/sandbox-launcher /usr/local/bin/launcher

COPY --from=sandbox-build / /sandbox-rootfs/

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg

RUN mkdir -p /host-packages

COPY launcher/entrypoint.sh /usr/local/bin/launcher-entrypoint.sh
COPY docker/start-direct-sandbox.sh /usr/local/bin/start-direct-sandbox.sh
COPY docker/sandbox-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/launcher-entrypoint.sh /usr/local/bin/start-direct-sandbox.sh /usr/local/bin/entrypoint.sh

EXPOSE 2000/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
