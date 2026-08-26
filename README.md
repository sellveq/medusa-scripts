# @selveq/medusa-scripts (`lma`)

Local dev CLI for Medusa: dockerized Postgres/Redis/nginx, port allocation, db
import/dump, admin seeding, Cloudflare tunnel. Config per project in `lma.js`
(`lma.cjs` in ESM projects), scaffolded by `lma init`.

Node ≥ 20 and Docker; `cloudflared` for tunnels. No runtime dependencies.

```bash
npm i -D @selveq/medusa-scripts
npx lma init
npm run lma start
```

Install first: the bare `lma` name on npm is an unrelated package.

## Commands

| command | does |
| --- | --- |
| `start` / `stop` / `restart` | infra + dev servers · stop keeps volumes |
| `status` / `logs [app]` | container and app state / logs |
| `destroy` | delete containers and volumes (confirm) |
| `ports [--reset]` | show or reallocate the port map |
| `import-db <f>` | drop, recreate, import .sql/.sql.gz/pg_dump (confirm) |
| `dump-db` / `reset-db` | dump to `.local-medusa-app/dumps/` / recreate empty (confirm) |
| `psql` / `redis` | shells into the containers |
| `migrate` | `medusa db:migrate`, then seed the admin |
| `seed-admin` / `admin` | create the configured admin / print its credentials |
| `show-env` | env lines for the backend `.env` |
| `tunnel setup/start/quick/stop/restart/status/logs` | Cloudflare tunnel |

`-n`/`--dry-run` prints the plan and changes nothing. `-y`/`--yes` answers the
confirmation and is required off a tty. One mutating command per project at a time.

## State

```text
.local-medusa-app/                       secrets.env (0600), dumps/, run/, tunnel/
node_modules/.local-medusa-app-cache/    ports.json, logs/
```

`rm -rf node_modules` costs a port map, never a password or a dump.
`.local-medusa-app/` ignores itself. Tunnel credentials live in
`~/.config/local-medusa-app/tunnels/`.

## What lma sets for the backend

Exported, so they win over the app's `.env` — dotenv does not override an export:

- `__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS` — Vite answers 403 to any `Host` it was not told about. From `proxy.domain`, `tunnel.hostnames`, `proxy.allowedHosts`.
- `STORE_CORS` / `ADMIN_CORS` / `AUTH_CORS` — additive: the backend `.env` is read and its origins come first.

Set at `lma start`, so `lma tunnel start` needs no restart. Everything else is injected only when the app has no `.env`.

## Tunnels

`start` and `quick` publish local ports on the public internet; the backend origin carries `/app`, `/auth` and every store route. Development data only.

- `setup`/`start` ask for any missing hostname and save it to `lma.js`. Public domains only: `localhost` and bare addresses are refused.
- Every publication prints its routes and needs `expose` typed (or `--yes`). The acceptance records hostname and port, so either changing asks again.
- A guessable admin password blocks publishing the backend
  (`LMA_TUNNEL_ALLOW_WEAK_ADMIN=1` overrides).
- `start` probes the running backend for Host and CORS acceptance.
- `stop` finds tunnels by pid, config path, metrics port and UUID.
- `quick` needs no hostname or account, but its URL arrives after the dev server starts, so the admin cannot work over one.

Universal SSL covers one subdomain level: `app.example.com` works,
`api.app.example.com` gets a TLS handshake failure.

## Notes

- Postgres and Redis bind to `127.0.0.1`; nginx routes `/app`, `/admin`, `/auth`, `/store`, `/hooks`, `/health` to the backend, the rest to the storefront.
- Ports allocate to the closest free one and stay pinned until `--reset`.
- A recorded pid is checked against the process start time before being signalled.
- Infra images are pinned by tag and digest in `lib/images.js`; `:latest` warns.
- Every config value has an `LMA_*` env override.

## Development

```bash
npm test
```

The real scripts against stand-in `docker` and `cloudflared` on `PATH` — no daemon, no network. CI runs them on Node 20, 22 and 24, plus shellcheck and one packed-tarball install that boots the real stack on Node 22.

## License

Copyright (c) 2026 Selveq. [MIT](./LICENSE).
