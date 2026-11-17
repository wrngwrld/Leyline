FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
ENV PORT=8787 INBOX_DIR=/data
EXPOSE 8787
# Unraid: run as nobody:users with --user 99:100 (the template does), so files match the rest of the share
HEALTHCHECK --interval=60s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.mjs"]
