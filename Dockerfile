FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# Runs the whole flow once and exits (triggered daily by Cloud Scheduler).
CMD ["node", "src/index.js"]
