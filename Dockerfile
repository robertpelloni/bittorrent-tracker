FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

# Default port for RPC
EXPOSE 3000
# Default port for P2P (will vary, but we can fix it if needed)

ENTRYPOINT ["node", "index.js"]
CMD ["serve"]
