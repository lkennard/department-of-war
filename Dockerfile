# Uses Playwright image with browsers preinstalled
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# App code
COPY . .

# Server settings
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Start server
CMD ["node", "index.js"]
