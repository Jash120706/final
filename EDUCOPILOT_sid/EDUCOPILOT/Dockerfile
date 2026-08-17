FROM node:22

WORKDIR /app

COPY server/package*.json ./server/

RUN cd server && npm install --omit=dev

COPY server ./server

COPY client/dist ./client/dist

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "server.js"]
