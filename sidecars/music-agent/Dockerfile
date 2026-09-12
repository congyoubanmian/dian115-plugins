FROM node:20-alpine
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev
COPY app/server.mjs app/fetch-worker.mjs ./
ENV PORT=8791
EXPOSE 8791
CMD ["node", "server.mjs"]
