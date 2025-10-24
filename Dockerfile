FROM node:18-alpine

WORKDIR /app

# Install kubectl
RUN apk add --no-cache curl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
RUN chmod +x kubectl && mv kubectl /usr/local/bin/

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy source code
COPY server.js ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S webhook -u 1001

# Change ownership
RUN chown -R webhook:nodejs /app
USER webhook

EXPOSE 8080

CMD ["node", "server.js"]
