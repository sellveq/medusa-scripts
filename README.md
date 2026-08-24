# @selveq/medusa-scripts (`lma`)

Local dev CLI for Medusa projects: dockerized Postgres/Redis/nginx, port
allocation, db import/dump, admin seeding, Cloudflare tunnel. One config file
per project: `lma.js` (`lma.cjs` in ESM projects), scaffolded by `lma init`.

Needs Node ≥ 20 and Docker; `cloudflared` for tunnels only.

## Install

```bash
npm i -D @selveq/medusa-scripts
npx lma init
npm run lma start
```

Install first: the bare `lma` name on the npm registry is an unrelated package.

## Commands

| command | does |
| --- | --- |
| `lma start` / `stop` / `restart` | start infra and dev servers · stop keeps volumes |
| `lma status` / `logs [app]` | container and app state / logs |
| `lma destroy` | delete containers and volumes (confirm) |
| `lma ports [--reset]` | show or reallocate the port map |
| `lma import-db <f>` | drop, recreate, import .sql/.sql.gz/pg_dump |
| `lma dump-db` / `reset-db` | dump to cache / recreate empty (confirm) |
| `lma psql` / `redis` | shells into the containers |
| `lma migrate` | `medusa db:migrate`, then seed the admin |
| `lma seed-admin` | create the configured admin if none exists (auto on start/migrate) |
| `lma show-env` | DATABASE_URL/REDIS_URL lines for the backend .env |
| `lma tunnel setup/start/quick/stop/restart/status/logs` | Cloudflare tunnel |
| `lma --version` | the installed version |

## Notes

- Postgres and Redis bind to `127.0.0.1` only; the nginx proxy is the front
  door, routing `/app`, `/admin`, `/auth`, `/store`, `/hooks`, `/health` →
  backend and everything else → storefront.
- Ports allocate to the closest available, pinned in
  `node_modules/.lma-cache/` next to secrets, dumps, and logs.
- Tunnel credentials live in `~/.config/lma/tunnels/` and survive clean
  installs.
- Every config value has an `LMA_*` env override.

## License

Copyright (c) 2026 Selveq. [MIT](./LICENSE).
