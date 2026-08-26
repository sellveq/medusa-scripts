// throwaway projects + fake docker/cloudflared on PATH
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PKG = path.join(__dirname, '..', '..')
const ASSETS = path.join(PKG, 'assets')
const FAKE_BIN = path.join(__dirname, 'bin')

// one port band per test process, below every OS ephemeral range (32768+)
const BASE = 21000 + (process.pid % 100) * 60
const PORTS = {
    postgres: BASE,
    redis: BASE + 10,
    http: BASE + 20,
    backend: BASE + 30,
    storefront: BASE + 40,
    metrics: BASE + 50,
}

const DEFAULTS = {
    project: 'demo',
    services: {
        postgres: { user: 'demo', password: 'demo', database: 'demo_db', port: PORTS.postgres },
        redis: { port: PORTS.redis },
    },
    admin: { email: 'admin@demo.local' },
    apps: {
        backend: { dir: 'apps/backend', port: PORTS.backend },
        storefront: { dir: 'apps/storefront', port: PORTS.storefront },
    },
    proxy: { domain: 'localhost', port: PORTS.http },
    // keep cloudflared's metrics listener inside this process's band too
    tunnel: { metricsPort: PORTS.metrics },
}

const merge = (base, extra) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra
    const out = { ...base }
    for (const [k, v] of Object.entries(extra)) {
        out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v
    }
    return out
}

const dirs = []

const project = (config = {}, { type } = {}) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lma-test-')))
    dirs.push(dir)
    const pkg = { name: 'demo-project', version: '1.0.0', private: true }
    if (type) pkg.type = type
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    const name = type === 'module' ? 'lma.cjs' : 'lma.js'
    fs.writeFileSync(
        path.join(dir, name),
        'module.exports = ' + JSON.stringify(merge(DEFAULTS, config), null, 4) + '\n'
    )
    return dir
}

const cleanup = () => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

// its own process: spawnSync blocks our event loop, so a server here could not answer
const SERVER = `
const http = require('http')
const [port, hosts, ready, origins] = process.argv.slice(1)
const allow = hosts ? hosts.split(',') : []
const allowOrigin = origins ? origins.split(',') : []
http.createServer((req, res) => {
    const h = String(req.headers.host || '').replace(/:\\d+$/, '')
    // same rule Vite applies: IPv4 literals and localhost are always allowed
    const free = require('net').isIP(h) === 4 || h === 'localhost' || h.endsWith('.localhost')
    if (!(free || allow.includes(h))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        return res.end('Blocked request. This host (' + JSON.stringify(h) + ') is not allowed.')
    }
    // Medusa echoes an allowed origin and omits the header for any other
    const origin = req.headers.origin
    const headers = {}
    if (origin && allowOrigin.includes(origin)) headers['access-control-allow-origin'] = origin
    res.writeHead(req.method === 'OPTIONS' ? 204 : 200, headers)
    res.end()
}).listen(Number(port), '127.0.0.1', () => require('fs').writeFileSync(ready, '1'))
`

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const serveApp = (dir, app, port, { allowedHosts = [], allowedOrigins = [] } = {}) => {
    const ready = path.join(dir, `${app}.listening`)
    fs.rmSync(ready, { force: true })
    const child = spawn(
        process.execPath,
        ['-e', SERVER, '--', String(port), allowedHosts.join(','), ready, allowedOrigins.join(',')],
        { stdio: 'ignore' }
    )
    // the allocator keeps a port whose app is alive, and preflight wants it up
    fs.mkdirSync(path.join(dir, '.local-medusa-app', 'run'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.local-medusa-app', 'run', `${app}.pid`), String(child.pid))
    const deadline = Date.now() + 5000
    while (!fs.existsSync(ready) && Date.now() < deadline) sleepSync(20)
    if (!fs.existsSync(ready)) throw new Error(`fake ${app} never listened on ${port}`)
    return () => { child.kill('SIGKILL') }
}

const holdAppPort = (dir, app, port) => serveApp(dir, app, port)

// double-forked so it is reparented to init; a direct child lingers as a zombie
const LAUNCHER = `
const { spawn } = require('child_process')
const [node, pidFile, ...argv] = process.argv.slice(1)
const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)', '--', ...argv], {
    stdio: 'ignore', detached: true,
})
child.unref()
require('fs').writeFileSync(pidFile, String(child.pid))
`

const daemon = (dir, argv) => {
    const pidFile = path.join(dir, `daemon-${argv[0]}-${Date.now?.() ?? 0}.pid`)
    spawnSync(process.execPath, ['-e', LAUNCHER, '--', process.execPath, pidFile, ...argv], { stdio: 'ignore' })
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    fs.rmSync(pidFile, { force: true })
    return pid
}

// the identity the scripts record next to a pid
const started = (pid) =>
    spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.replace(/ +/g, ' ')

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }

const dockerLog = (dir) => path.join(dir, 'docker.log')

// eslint-disable-next-line no-control-regex
const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '')

const dockerRuns = (dir) => {
    try {
        return fs.readFileSync(dockerLog(dir), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    } catch { return [] }
}

const dockerCalls = (dir) => dockerRuns(dir).map((r) => r.argv)

const composeImages = (dir) =>
    (dockerRuns(dir).find((r) => r.argv[0] === 'compose') || {}).images || {}

const ranDocker = (dir, ...words) =>
    dockerCalls(dir).some((argv) => words.every((w) => argv.includes(w)))

const engine = (script, args, { cwd, env = {}, input = '' } = {}) => {
    const r = spawnSync('bash', [path.join(ASSETS, script), ...args], {
        cwd,
        input,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
            LMA_ASSETS: ASSETS,
            LMA_ROOT: cwd,
            LMA_TEST_DOCKER_LOG: dockerLog(cwd),
            LMA_TEST_CLOUDFLARED_LOG: path.join(cwd, 'cloudflared.log'),
            LMA_TEST_NPM_LOG: path.join(cwd, 'npm.log'),
            ...env,
        },
    })
    return { ...r, out: strip((r.stdout || '') + (r.stderr || '')) }
}

const devRuns = (dir) => {
    try {
        return fs.readFileSync(path.join(dir, 'npm.log'), 'utf8')
            .trim().split('\n').filter(Boolean).map(JSON.parse)
    } catch { return [] }
}

const devEnv = (dir, app) =>
    (devRuns(dir).find((r) => r.cwd.endsWith(app)) || {}).env || {}

const cloudflaredCalls = (dir) => {
    try {
        return fs.readFileSync(path.join(dir, 'cloudflared.log'), 'utf8')
            .trim().split('\n').filter(Boolean).map(JSON.parse)
    } catch { return [] }
}

const local = (args, opts) => engine('local.sh', args, opts)
const tunnel = (args, opts) => engine('tunnel.sh', args, opts)

const cli = (args, { cwd, env = {} } = {}) => {
    const r = spawnSync(process.execPath, [path.join(PKG, 'bin', 'lma.js'), ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
            LMA_TEST_DOCKER_LOG: dockerLog(cwd),
            ...env,
        },
    })
    return { ...r, out: strip((r.stdout || '') + (r.stderr || '')) }
}

module.exports = {
    PKG, ASSETS, FAKE_BIN, DEFAULTS, PORTS,
    project, cleanup, holdAppPort, serveApp, daemon, alive, killQuietly, started, sleep: sleepSync,
    local, tunnel, cli,
    dockerCalls, ranDocker, composeImages, cloudflaredCalls, devRuns, devEnv,
}
