FROM node:22-alpine

# Alpine has no "google-chrome" package (that's Debian/Ubuntu only), so PDF
# generation (investigationPdfService.js) uses Chromium here instead. The extra
# packages are Chromium's runtime deps on Alpine (fonts, freetype, harfbuzz) —
# without them it fails to launch at all, not just render fonts wrong.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# The real binary, not the /usr/bin/chromium-browser wrapper script: that wrapper
# runs as root and *always* prepends --user-data-dir=/root/.config/chromium (its
# "upstream failsafe" workaround for running as root), ahead of whatever we pass —
# so every invocation contends for one shared profile lock no matter what
# --user-data-dir investigationPdfService.js supplies. Calling the binary directly
# means our unique-per-call --user-data-dir is the only one in effect.
ENV CHROME_PATH=/usr/lib/chromium/chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 2003

CMD ["node", "src/index.js"]
