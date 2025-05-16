# Use official Node.js LTS image
FROM node:18-slim

# Install FFmpeg and Python (required for video processing)
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Expose port
EXPOSE 8080

# Start command
CMD ["npm", "start"]