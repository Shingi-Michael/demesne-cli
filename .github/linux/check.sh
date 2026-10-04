#!/bin/sh
set -eux
timeout 90s bun scripts/check-linux-graphics.ts
timeout 120s bun scripts/capture-readme.ts /workspace/test-results/linux-graphics
timeout 120s bun run build:graphics
# A packaged bundle must carry a normal helper file, not the build machine's privileged link.
test ! -L dist/graphics/runtime/chrome-sandbox
test "$(stat -c %a dist/graphics/runtime/chrome-sandbox)" = 755
# The explicit setup path must also work for the compiled host without a TTY.
./dist/graphics/host --install-sandbox
./dist/graphics/host --check-runtime
