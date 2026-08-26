// closest available ports: probe upward from each preferred port, pinned until --reset
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { execSync } = require('node:child_process')
const config = require('./config.js')
const paths = require('./paths.js')

const cacheDir = (root) => paths.cacheDir(root)

const cachePath = (root) => path.join(cacheDir(root), 'ports.json')

const pathId = (root) => {
    const s = path.resolve(root)
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    return h
}

const projectId = (root, lma = config.load(root)) => lma.projectId || pathId(root)

const projectName = (root, lma = config.load(root)) =>
    `${config.project(root, lma)}-${projectId(root, lma)}`

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

// EACCES counts as bindable: the root Docker daemon can still publish a privileged port (80)
const bindable = (port, host) => new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (e) => resolve(e.code === 'EACCES'))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
})

const isFree = async (port) =>
    (await bindable(port, '0.0.0.0')) && (await bindable(port, '127.0.0.1'))

const ownDockerPorts = (project) => {
    try {
        const out = execSync(
            `docker ps --filter "name=${project}-" --format "{{.Ports}}"`,
            { stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString()
        return new Set([...out.matchAll(/:(\d+)->/g)].map((m) => Number(m[1])))
    } catch { return new Set() }
}

// same rule local.sh applies: a live pid is ours only if it started when we recorded
const startedAt = (pid) => {
    try {
        return execSync(`ps -p ${pid} -o lstart=`, { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().replace(/ +/g, ' ').trim()
    } catch { return '' }
}

const ownAppAlive = (root, svc) => {
    try {
        const pid = parseInt(
            fs.readFileSync(paths.sub(root, 'run', `${svc}.pid`), 'utf8'), 10)
        if (!Number.isInteger(pid) || pid <= 0) return false
        process.kill(pid, 0)
        let recorded = ''
        try { recorded = fs.readFileSync(paths.sub(root, 'run', `${svc}.id`), 'utf8').trim() }
        catch { return true } // nothing recorded: the pid is all we have
        return recorded === startedAt(pid)
    } catch (e) { return e.code === 'EPERM' }
}

async function resolve(root, { reset = false } = {}) {
    const lma = config.load(root)
    const bases = basePorts(lma)
    paths.ensure(root)
    const file = cachePath(root)
    let cached = {}
    if (!reset) {
        try { cached = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run */ }
    }
    const own = ownDockerPorts(projectName(root, lma))
    const ports = {}
    const taken = new Set()
    for (const [svc, base] of Object.entries(bases)) {
        const start = Number.isInteger(cached[svc]) ? cached[svc] : base
        const appAlive = ownAppAlive(root, svc)
        let p = start
        for (;;) {
            const heldBySelf = own.has(p) || (appAlive && p === start)
            if (!taken.has(p) && (heldBySelf || await isFree(p))) break
            p += 1
            if (p > base + 100) throw new Error(`no free port near ${base} for ${svc}`)
        }
        taken.add(p)
        ports[svc] = p
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(ports, null, 2) + '\n')
    return { ports, bases, cachePath: file }
}

module.exports = { resolve, cachePath, cacheDir, basePorts, projectId, projectName }
