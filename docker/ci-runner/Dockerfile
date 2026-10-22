FROM denoland/deno:2.9.6 AS deno
FROM oven/bun:1.4.0 AS bun
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git iproute2 procps unzip \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY --from=deno /usr/bin/deno /usr/local/bin/deno
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=alpine/helm:3.16.3 /usr/bin/helm /usr/bin/helm
ENV DENO_NO_UPDATE_CHECK=1
CMD ["sleep", "infinity"]
