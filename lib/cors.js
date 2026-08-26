// origins the backend must accept, per medusa route group
const VARS = ['STORE_CORS', 'ADMIN_CORS', 'AUTH_CORS']

const split = (v) =>
    (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean)

const dedupe = (...lists) => {
    const out = []
    for (const item of lists.flatMap(split)) if (!out.includes(item)) out.push(item)
    return out
}

const baseUrl = (cfg, httpPort) => {
    const domain = (cfg.proxy || {}).domain || 'localhost'
    return Number(httpPort) === 80 ? `http://${domain}` : `http://${domain}:${httpPort}`
}

const tunnelOrigin = (cfg, app) => {
    const host = ((cfg.tunnel || {}).hostnames || {})[app]
    return host ? `https://${host}` : ''
}

const owned = (cfg, ports = {}) => {
    const base = baseUrl(cfg, ports.http)
    const store = dedupe(base, ports.storefront ? `http://localhost:${ports.storefront}` : '', tunnelOrigin(cfg, 'storefront'))
    const admin = dedupe(base, ports.backend ? `http://localhost:${ports.backend}` : '', tunnelOrigin(cfg, 'backend'))
    return { STORE_CORS: store, ADMIN_CORS: admin, AUTH_CORS: dedupe(store, admin) }
}

// additive: a project sets these itself, so lma only ever appends
const resolve = (cfg, ports, { env = {}, appEnv = {} } = {}) => {
    const mine = owned(cfg, ports)
    const out = {}
    for (const key of VARS) out[key] = dedupe(env[key], appEnv[key], mine[key]).join(',')
    return out
}

const missing = (existing, cfg, ports, key) =>
    owned(cfg, ports)[key].filter((o) => !split(existing).includes(o))

module.exports = { VARS, owned, resolve, missing, dedupe, split, baseUrl, tunnelOrigin }
