# Patient Investigation Chart

React + Vite frontend with a Node.js Express API — migrated from `investigation.php`.

## Structure

```
patient-investigation/
├── client/          # React + Vite UI
├── server/          # Node.js Express API (EMR integration)
└── investigation.php  # Original PHP (kept for reference)
```

## Setup

1. Install dependencies:

```bash
npm run install:all
```

2. Configure EMR credentials in `server/.env` (copy from `server/.env.example` if needed).

3. Run both frontend and backend:

```bash
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:6001

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/config/hospital` | Hospital letterhead config |
| POST | `/api/search` | Search lab results + build chart |
| GET | `/api/detail/:orderid` | Fetch raw lab detail for a request |

### Search body

```json
{
  "regNo": "4975109",
  "fromDate": "2025-01-01T00:00",
  "toDate": "2025-01-31T23:59"
}
```

## Production

```bash
npm run build          # builds client to client/dist
npm run start          # starts API on port 6001
```

Serve `client/dist` via your web server and proxy `/api` to the Node server, or add static file serving to Express.

## Docker

Requires Docker Desktop (or Docker Engine + Compose).

1. Ensure `server/.env` exists with your EMR credentials.

2. Build and start both containers:

```bash
docker compose up --build -d
```

Or use the npm script:

```bash
npm run docker:up
```

3. Open the app at **http://localhost:8080**

| Service | Container | Port |
|---------|-----------|------|
| React UI (nginx) | `patient-investigation-client` | `8080` → `80` |
| Node API | `patient-investigation-server` | internal `3001` |

The client container proxies `/api` requests to the server container on the Docker network.

Useful commands:

```bash
docker compose logs -f      # follow logs
docker compose down         # stop containers
npm run docker:down
```

## Notes

- EMR credentials live in `server/.env` only — never commit real passwords to git.
- Chart template aliases are in `server/src/templates/chartTemplate.js`.
"# investigation-chart" 
