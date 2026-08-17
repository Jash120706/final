FROM node:22

WORKDIR /app

# Copy server package files
COPY server/package*.json ./server/

# Install backend dependencies
RUN cd server && npm install --omit=dev

# Copy backend
COPY server ./server

# Copy React production build
COPY client/dist ./client/dist

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "server.js"]
