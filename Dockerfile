FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG CERES_REVISION
LABEL org.opencontainers.image.source="https://github.com/hcltech-robotics/ceres" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${CERES_REVISION}"
WORKDIR /app
COPY --chown=node:node dist ./dist
COPY --chown=node:node dist-server ./dist-server
COPY --chown=node:node third-party ./third-party
COPY LICENCE.md CITATION.cff citation.bib ./
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production CERES_BIND_HOST=0.0.0.0 CERES_DATA_DIR=/data CERES_SPEECH_ENABLED=0 PORT=4317
EXPOSE 4317
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('http').get('http://127.0.0.1:4317/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist-server/ceres-server.cjs"]
