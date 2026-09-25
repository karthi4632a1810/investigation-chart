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

## Production (invest.mapims.edu.in)

Uses unique host port **8094** (avoids conflicts with other Docker apps on the server).

### 1. Deploy containers on server

```bash
git checkout production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Or:

```bash
npm run docker:prod
```

| Service | Container | Host port |
|---------|-----------|-----------|
| React UI | `invest_client` | **8094** |
| Node API | `invest_server` | internal only |

Test directly: `http://SERVER_IP:8094`

### 2. Install host nginx config

```bash
sudo cp deploy/nginx/invest.mapims.edu.in.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/invest.mapims.edu.in.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then open **http://invest.mapims.edu.in**

### 3. Enable HTTPS (recommended)

```bash
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d invest.mapims.edu.in
sudo cp deploy/nginx/invest.mapims.edu.in.ssl.conf /etc/nginx/sites-available/invest.mapims.edu.in.conf
sudo nginx -t && sudo systemctl reload nginx
```

## Notes

- EMR credentials live in `server/.env` only — never commit real passwords to git.
- Chart template aliases are in `server/src/templates/chartTemplate.js`.
"# investigation-chart" 
