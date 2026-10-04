ARG UBUNTU_VERSION=20.04
FROM ubuntu:${UBUNTU_VERSION}
ARG UBUNTU_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git sudo xvfb xauth \
    libgtk-3-0 libnss3 libgbm1 libatk-bridge2.0-0 libcups2 \
    $(if [ "$UBUNTU_VERSION" = "24.04" ]; then echo libasound2t64; else echo libasound2; fi) \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip -o /tmp/bun.zip \
    && unzip /tmp/bun.zip -d /opt && ln -s /opt/bun-linux-x64/bun /usr/local/bin/bun && rm /tmp/bun.zip
RUN useradd -m -u 1001 demo && echo 'demo ALL=(root) NOPASSWD: /bin/sh' > /etc/sudoers.d/demesne-fixture && chmod 440 /etc/sudoers.d/demesne-fixture
WORKDIR /workspace
COPY --chown=1001:1001 . .
RUN chown 1001:1001 /workspace
ENV HOME=/home/demo
USER 1001:1001
RUN bun install --frozen-lockfile && bun run graphics:setup --download-only
ENV DEMESNE_GRAPHICS_GPU=0
CMD ["xvfb-run", "-a", "sh", ".github/linux/check.sh"]
