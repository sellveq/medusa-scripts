# @selveq/medusa-scripts (`lmca`)

Local development CLI for Medusa (or any Node) projects: dockerized Postgres 16 +
Redis 7 + nginx reverse proxy, closest-available port allocation, database
import/dump/reset, admin seeding, and a Cloudflare tunnel — driven by one
per-project config file, `lmca.js`.

Local tooling only. macOS/Linux, requires Docker Desktop and Node ≥ 20;
`cloudflared` only for the tunnel commands.

## Install

```bash
npm i -D @selveq/medusa-scripts    # per project; auto-adds the `lmca` npm script
cd my-shop
npm run lmca init               # scaffolds lmca.js (add --scripts for more aliases)
npm run lmca start
```

`npx lmca` always works too. If the install ran with `--ignore-scripts`, the
`lmca` npm script is not auto-added — add it with `npx lmca init --scripts`.

The proxy serves `http://localhost` by default. For a named domain instead, set
`proxy: { domain: 'my-shop.local' }` in lmca.js and add the /etc/hosts entry
(`lmca start` prints the exact command when it's missing).

npm scripts are optional — the binary is the interface. `lmca init --scripts`
merges `npm run` aliases into package.json for those who want them.

## Per-project footprint

- `lmca.js` — the only committed file: project, db credentials, admin
  email/password, app dirs, proxy domain, tunnel name/hostnames. No ports and
  no projectId: ports default (5432/6379/80/9000/8000) and allocate to the
  closest available; the project id derives from a stable hash of the project
  path (same folder → same id, checkouts never clash)
- `node_modules/.lmca-cache/` — machine-local, disposable state:
  `port-config.json` (allocated ports), `secrets.env` (generated
  JWT/cookie secrets), `dumps/` (db dumps), `tunnel/` (cloudflared config +
  logs). Wiped by a clean install — everything regenerates automatically.
- `~/.config/lmca/tunnels/<name>.json` — the cloudflared tunnel credentials.
  Kept outside node_modules because the secret cannot be re-downloaded;
  it survives clean installs.

## Commands

| command | does |
| --- | --- |
| `lmca start` / `stop` / `restart` | start Docker (asks!) + postgres/redis/proxy · stop removes containers+network, keeps volumes |
| `lmca status` / `logs` | visibility |
| `lmca destroy` | delete containers AND volumes (confirm) |
| `lmca ports [--reset]` | show / reallocate the closest-available port map |
| `lmca import-db <f>` | drop, recreate, import .sql/.sql.gz/pg_dump |
| `lmca dump-db` / `reset-db` | dump to cache / recreate empty (confirm) |
| `lmca psql` / `redis` | shells into the containers |
| `lmca migrate` | `medusa db:migrate` in the backend dir, then seed the admin |
| `lmca seed-admin` | create the lmca.js admin user if no admin exists yet |
| `lmca show-env` | DATABASE_URL/REDIS_URL lines for the backend .env |
| `lmca tunnel setup/start/quick/stop/status/logs` | Cloudflare tunnel (hostnames from lmca.js) |

Ports: preferred values live in lmca.js; the first run allocates the closest
available port upward from each (ports held by this project's own containers
count as available) and pins the result in the cache until `lmca ports --reset`.

The proxy routes by path on `http://localhost` (or `proxy.domain` if set):
`/app`, `/admin`, `/auth`, `/store`, `/hooks`, `/health` → backend; everything
else → storefront (exact `/admin` redirects to `/app`). Apps stay reachable on
their plain ports too.

Every lmca.js value has a `LMCA_*` env override (`LMCA_PG_PORT=5433 lmca start`).

## License

[OSL-3.0](./LICENSE) (Open Software License 3.0).
