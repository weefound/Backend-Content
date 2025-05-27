# Use an official Node.js image as the base
FROM node:18

# Install ffmpeg (includes ffprobe)
RUN apt-get update \
    && apt-get install -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app code
COPY . .

# Expose the port your app runs on (optional, e.g. 3000)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]