# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (sodium-native)
RUN apk add --no-cache python3 make g++ libtool autoconf automake

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime dependencies for native modules
RUN apk add --no-cache libc6-compat

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create data directory for JSON storage
RUN mkdir -p /app/data

# Set environment
ENV NODE_ENV=production

# Run the bot
CMD ["node", "dist/index.js"]
