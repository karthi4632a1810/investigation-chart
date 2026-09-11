# Deploying to the Hostinger VPS

Target: `194.238.22.210`. This deploys the whole stack (frontend, API, Mongo,
MinIO) via Docker Compose, the same way it runs locally — just with the
production port bindings in [docker-compose.prod.yml](docker-compose.prod.yml).

## 1. One-time server setup

SSH in, then install Docker + the Compose plugin (Ubuntu):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in for this to take effect
```

## 2. Get the code

```bash
git clone https://github.com/karthi4632a1810/investigation-chart.git
cd investigation-chart
git checkout production
```

## 3. Configure secrets

Neither `.env` file is in git — copy the examples and fill in real values:

```bash
cp .env.production.example .env
cp server/.env.production.example server/.env
```

Edit both:
- `.env` — generate a real MinIO root user/password (`openssl rand -base64 24`),
  confirm `MINIO_PUBLIC_ENDPOINT=194.238.22.210`. If this VPS is shared with
  other apps (it is — check `docker ps` first), the `*_PORT_BIND` vars here
  are what keep the backend/Mongo/MinIO-console off the public internet and
  off ports other containers already hold; adjust the loopback port numbers
  if the ones in the example collide too.
- `server/.env` — set `APP_USERNAME`/`APP_PASSWORD` (the app's own login, not
  EMR), the same MinIO credentials as above, and the real `EMR_USERNAME`/
  `EMR_PASSWORD`.

## 4. Start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

This exposes:
- `1003` — the app (UI + `/api` proxy)
- `4003` — MinIO's S3 API (needed so browsers can download PDFs directly via
  presigned URLs)

Everything else (backend's own port, Mongo, MinIO console) is bound to
`127.0.0.1` only — not reachable from outside the VPS.

## 5. Firewall

Only open what's actually served publicly:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 1003/tcp
sudo ufw allow 4003/tcp
sudo ufw default deny incoming
sudo ufw enable
```

Do this **before** `docker compose up`, not after — Docker inserts its own
iptables rules that can bypass a `ufw` policy applied too late. If you already
started the stack, run `docker ps` afterward and confirm nothing besides
`1003`/`4003` shows a `0.0.0.0:` binding.

## 6. Verify

```bash
curl -I http://194.238.22.210:1003
```

Open `http://194.238.22.210:1003` in a browser and log in.

## Updating a running deployment

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

## Data

`mongo-data` and `minio-data` are named Docker volumes — they persist across
`up`/`down`, but not across `docker compose down -v` or `docker volume rm`.
Back those up periodically; they hold all discharge report metadata and PDFs.
