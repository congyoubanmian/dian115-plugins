FROM node:20-alpine
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev
COPY app/agent.mjs app/fetch-worker.mjs ./
ENV PORT=8790
EXPOSE 8790
CMD ["node", "agent.mjs"]
