FROM mcr.microsoft.com/playwright:v1.45.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

**`.dockerignore`**
```
node_modules
npm-debug.log
.git
.gitignore
