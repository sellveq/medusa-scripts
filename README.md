# @selveq/medusa-scripts (`lma`)

Local development CLI for Medusa (or any Node) projects: dockerized Postgres 16 +
Redis 7 + nginx reverse proxy, closest-available port allocation, database
import/dump/reset, admin seeding, and a Cloudflare tunnel — driven by one
per-project config file, `lma.js`.

Local tooling only. macOS/Linux, requires Docker Desktop and Node ≥ 20;
`cloudflared` only for the tunnel commands.

## Install

```bash
npm i -D @selveq/medusa-scripts    # per project; auto-adds the `lma` npm script
cd my-shop
npm run lma init               # scaffolds lma.js (add --scripts for more aliases)
npm run lma start
```

`npx lma` always works too. If the install ran with `--ignore-scripts`, the
`lma` npm script is not auto-added — add it with `npx lma init --scripts`.

The proxy serves `http://localhost` by default. For a named domain instead, set
`proxy: { domain: 'my-shop.local' }` in lma.js and add the /etc/hosts entry
(`lma start` prints the exact command when it's missing).

npm scripts are optional — the binary is the interface. `lma init --scripts`
merges `npm run` aliases into package.json for those who want them.

## Per-project footprint

- `lma.js` — the only committed file: project, db credentials, admin
  email/password, app dirs, proxy domain, tunnel name/hostnames. No ports and
  no projectId: ports default (5432/6379/80/9000/8000) and allocate to the
  closest available; the project id derives from a stable hash of the project
  path (same folder → same id, checkouts never clash)
- `node_modules/.lma-cache/` — machine-local, disposable state:
  `port-config.json` (allocated ports), `secrets.env` (generated
  JWT/cookie secrets), `dumps/` (db dumps), `tunnel/` (cloudflared config +
  logs). Wiped by a clean install — everything regenerates automatically.
- `~/.config/lma/tunnels/<name>.json` — the cloudflared tunnel credentials.
  Kept outside node_modules because the secret cannot be re-downloaded;
  it survives clean installs.

## Commands

| command | does |
| --- | --- |
| `lma start` / `stop` / `restart` | start Docker (asks!) + postgres/redis/proxy · stop removes containers+network, keeps volumes |
| `lma status` / `logs` | visibility |
| `lma destroy` | delete containers AND volumes (confirm) |
| `lma ports [--reset]` | show / reallocate the closest-available port map |
| `lma import-db <f>` | drop, recreate, import .sql/.sql.gz/pg_dump |
| `lma dump-db` / `reset-db` | dump to cache / recreate empty (confirm) |
| `lma psql` / `redis` | shells into the containers |
| `lma migrate` | `medusa db:migrate` in the backend dir, then seed the admin |
| `lma seed-admin` | create the lma.js admin user if no admin exists yet — also runs automatically on `start` and `migrate`, and only ever seeds into a migrated DB with zero admin accounts |
| `lma show-env` | DATABASE_URL/REDIS_URL lines for the backend .env |
| `lma tunnel setup/start/quick/stop/status/logs` | Cloudflare tunnel (hostnames from lma.js) |

Ports: preferred values live in lma.js; every run allocates the closest
available port upward from each preferred value (80→81, 9000→9001, …) and
pins the result in the cache. Pins are re-validated on every run: a port held
by this project's own containers or dev servers stays put, while a pin that
another process has taken since moves to the nearest free sibling.
`lma ports --reset` reallocates everything from the preferred values.

The proxy routes by path on `http://localhost` (or `proxy.domain` if set):
`/app`, `/admin`, `/auth`, `/store`, `/hooks`, `/health` → backend; everything
else → storefront (exact `/admin` redirects to `/app`). Apps stay reachable on
their plain ports too.

Every lma.js value has a `LMA_*` env override (`LMA_PG_PORT=5433 lma start`).

## License

[OSL-3.0](./LICENSE) (Open Software License 3.0).
