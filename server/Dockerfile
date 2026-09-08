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

ENV CHROME_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 2003

CMD ["node", "src/index.js"]
