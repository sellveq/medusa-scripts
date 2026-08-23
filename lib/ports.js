// Closest-available port allocation: probe upward from each preferred port,
// pin the result in the cache until `lma ports --reset`.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { execSync } = require('node:child_process')

const cacheDir = (root) =>
    path.join(root, 'node_modules', '.lma-cache')

const cachePath = (root) => path.join(cacheDir(root), 'port-config.json')

const loadCma = (root) => {
    try { return require(path.join(root, 'lma.js')) } catch { return {} }
}

// stable id from the project's absolute path: same folder -> same id
const pathId = (root) => {
    const s = path.resolve(root)
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    return h
}

const projectId = (root, lma = loadCma(root)) => lma.projectId || pathId(root)

const projectName = (root, lma = loadCma(root)) =>
    `${lma.project || path.basename(path.resolve(root))}-${projectId(root, lma)}`

const basePorts = (lma) => {
    const s = lma.services || {}
    const a = lma.apps || {}
    const x = lma.proxy || {}
    const map = {
        http: Number(x.port) || 80,
        postgres: Number((s.postgres || {}).port) || 5432,
        redis: Number((s.redis || {}).port) || 6379,
    }
    const appDefaults = { backend: 9000, storefront: 8000 }
    for (const [k, v] of Object.entries(a)) {
        const base = Number((v || {}).port) || appDefaults[k]
        if (base) map[k] = base
    }
    return map
}

const isFree = (port) => new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e) => resolve(e.code === 'EACCES'))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '0.0.0.0')
})

// the project's own published ports count as available on re-resolution
const ownDockerPorts = (project) => {
    try {
        const out = execSync(
            `docker ps --filter "name=${project}-" --format "{{.Ports}}"`,
            { stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString()
        return new Set([...out.matchAll(/:(\d+)->/g)].map((m) => Number(m[1])))
    } catch { return new Set() }
}

async function resolve(root, { reset = false } = {}) {
    const lma = loadCma(root)
    const bases = basePorts(lma)
    const file = cachePath(root)
    let cached = {}
    if (!reset) {
        try { cached = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run */ }
    }
    const own = ownDockerPorts(projectName(root, lma))
    const ports = {}
    const taken = new Set()
    for (const [svc, base] of Object.entries(bases)) {
        let p
        if (Number.isInteger(cached[svc])) {
            p = cached[svc] // pinned until --reset
        } else {
            p = base
            while (taken.has(p) || !(own.has(p) || await isFree(p))) {
                p += 1
                if (p > base + 100) throw new Error(`no free port near ${base} for ${svc}`)
            }
        }
        taken.add(p)
        ports[svc] = p
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(ports, null, 2) + '\n')
    return { ports, bases, cachePath: file }
}

module.exports = { resolve, cachePath, cacheDir, basePorts, projectId, projectName }
