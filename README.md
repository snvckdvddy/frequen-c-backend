# Frequen-C Backend

Express + Socket.io + SQLite backend for the Frequen-C mobile app.

## Getting Started

```bash
npm install
cp .env.example .env
npm run dev
```

## API & WebSocket

- REST API: http://localhost:5000/api
- Socket.io: ws://localhost:5000
- Health check: http://localhost:5000/api/health

## Build & Production

```bash
npm run build
npm start
```