FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev >/dev/null 2>&1 && npx playwright install --with-deps chromium >/dev/null 2>&1 && chmod -R a+rX /ms-playwright
COPY server.js limits.js auth.js exporter.js direct-export.js artwork.js embedded-artwork.js root.playwright.js zip-stream.js ./
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
