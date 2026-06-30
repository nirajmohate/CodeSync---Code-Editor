# Stage 1 — Build React frontend
FROM node:20-alpine AS frontend-builder

COPY ./Frontend /app
WORKDIR /app
RUN npm install
RUN npm run build

# Stage 2 — Production backend (serves built frontend as static files)
FROM node:20-alpine

COPY ./Backend /app
WORKDIR /app
RUN npm install --omit=dev

COPY --from=frontend-builder /app/dist /app/public

ENV PORT=3000
ENV NODE_ENV=production
# Override these at deploy time — do not ship with insecure defaults
ENV CORS_ORIGIN=http://localhost:3000

EXPOSE 3000

CMD ["node", "server.js"]
