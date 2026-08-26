// hostnames the admin's vite dev server must accept
const ENV_VAR = '__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS'

// vite allows these itself
const alwaysAllowed = (host) =>
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)

const clean = (host) => String(host).trim().replace(/:\d+$/, '')

const adminAllowedHosts = (cfg = {}, extra = []) => {
    const proxy = cfg.proxy || {}
    const tunnel = cfg.tunnel || {}
    const candidates = [
        proxy.domain,
        ...Object.values(tunnel.hostnames || {}),
        ...(Array.isArray(proxy.allowedHosts) ? proxy.allowedHosts : []),
        ...extra,
    ]
    const out = []
    for (const raw of candidates) {
        if (!raw) continue
        const host = clean(raw)
        // a leading-dot wildcard is deliberate, keep it as written
        if (host[0] !== '.' && alwaysAllowed(host)) continue
        if (!out.includes(host)) out.push(host)
    }
    return out
}

const merge = (inherited, hosts) => {
    const out = []
    for (const h of [...String(inherited || '').split(','), ...hosts]) {
        const host = clean(h)
        if (host && !out.includes(host)) out.push(host)
    }
    return out
}

module.exports = { ENV_VAR, adminAllowedHosts, merge, alwaysAllowed }
