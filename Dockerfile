# LookyLooky — network camera relay
FROM node:22-alpine

# ffmpeg (+ffprobe) does every camera connection; openssl makes the local HTTPS
# certificate; tini reaps ffmpeg children and forwards signals.
RUN apk add --no-cache ffmpeg openssl tini tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    LOOKY_DATA_DIR=/data \
    LOOKY_SEED_DIR=/seed \
    LOOKY_HTTP_PORT=8080 \
    LOOKY_HTTPS_PORT=8443

RUN mkdir -p /data /seed && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LOOKY_HTTP_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
