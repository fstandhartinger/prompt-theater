FROM node:20-bookworm-slim
ARG MEDIAMTX_VERSION=v1.15.4
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg supervisor fonts-dejavu-core && rm -rf /var/lib/apt/lists/* \
 && detected_arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && case "$detected_arch" in amd64) a=amd64;; arm64) a=arm64v8;; *) echo "unsupported architecture: $detected_arch"; exit 1;; esac \
 && curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${a}.tar.gz" | tar -xz -C /usr/local/bin mediamtx
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY test ./test
COPY mediamtx.yml supervisord.conf ./
COPY scripts ./scripts
RUN mkdir -p /data/scenes && chown -R node:node /data
EXPOSE 3000 8888 1935
CMD ["/usr/bin/supervisord","-c","/app/supervisord.conf"]
