# --- Stage 1: build the Vite frontend ---
FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Stage 2: python backend serving API + static frontend ---
FROM python:3.12-slim AS runtime
WORKDIR /app

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/
# Vite build output -> served as static files by FastAPI
COPY --from=frontend /app/dist ./server/static

EXPOSE 7860
ENV PORT=7860
CMD ["python", "server/app.py"]
