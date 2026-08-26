// the only thing here that reaches the public internet
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { project, cleanup, tunnel, holdAppPort, serveApp, daemon, alive, killQuietly, cloudflaredCalls, PORTS } = require('./support/harness.js')

const credentials = (dir) => {
    const creds = path.join(dir, 'config', 'local-medusa-app', 'tunnels')
    fs.mkdirSync(creds, { recursive: true })
    fs.writeFileSync(path.join(creds, 'demo.json'), '{"AccountTag":"test"}')
    return { XDG_CONFIG_HOME: path.join(dir, 'config') }
}

test.after(cleanup)

const HOSTS = { tunnel: { name: 'demo', hostnames: { storefront: 'shop.example.test', backend: 'api.example.test' } } }
// `tunnel list` and `route dns` do not count as a launch
const launches = (dir) =>
    cloudflaredCalls(dir).filter((a) => a[0] === 'tunnel' && (a.includes('run') || a.includes('--url')))
const launched = (dir) => launches(dir).length > 0
const ingress = (dir) => path.join(dir, '.local-medusa-app', 'tunnel', 'config.yml')
const pidFile = (dir) => path.join(dir, '.local-medusa-app', 'tunnel', 'cloudflared.pid')

test('help spells out what start and quick publish', () => {
    const dir = project(HOSTS)
    const r = tunnel(['help'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /publish local ports on the public internet/)
    assert.match(r.out, /Admin dashboard/)
    assert.match(r.out, /production data or production credentials/i)
})

test('start --dry-run answers what would go public, before any setup', () => {
    const dir = project(HOSTS)
    const r = tunnel(['start', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /https:\/\/shop\.example\.test → localhost:\d+/)
    assert.match(r.out, /https:\/\/api\.example\.test → localhost:\d+/)
    assert.match(r.out, /includes the Admin dashboard at \/app/)
    assert.match(r.out, /not set up yet; run: lma tunnel setup/)
    assert.ok(!launched(dir), 'a dry run must not start cloudflared')
})

test('start --dry-run says it will ask for the hostnames it is missing', () => {
    const r = tunnel(['start', '--dry-run'], { cwd: project() })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /ask for a public hostname for backend storefront/)
    assert.match(r.out, /save it to lma\.js/)
})

const hostnames = (dir) => require(path.join(dir, 'lma.js')).tunnel.hostnames

test('quick publishes an app the config has no hostname for', async () => {
    const dir = project()
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        const r = tunnel(['quick', 'storefront', '--yes'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, /trycloudflare\.com/)
        assert.ok(launched(dir))
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('start asks for a missing hostname and writes it into the config', async () => {
    const dir = project()
    const release = await serveApp(dir, 'backend', PORTS.backend, {
        allowedHosts: ['api.example.test'],
        allowedOrigins: ['https://api.example.test'],
    })
    try {
        const r = tunnel(['start', 'backend', '--yes'], {
            cwd: dir,
            env: credentials(dir),
            input: 'https://api.example.test/\n',
        })
        assert.strictEqual(r.status, 0, r.out)
        assert.strictEqual(hostnames(dir).backend, 'api.example.test', 'saved for next time')
        assert.match(r.out, /https:\/\/api\.example\.test/)
        assert.match(fs.readFileSync(ingress(dir), 'utf8'), /hostname: api\.example\.test/)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

const REFUSED = ['not a hostname', 'localhost', '127.0.0.1', 'foo', 'foo..example.com', '*.example.com', 'example .com']

test('only a resolvable public hostname is accepted; the rest are asked again', async () => {
    const dir = project()
    const release = await serveApp(dir, 'backend', PORTS.backend, { allowedHosts: ['api.example.test'] })
    try {
        const r = tunnel(['start', 'backend', '--yes'], {
            cwd: dir,
            env: credentials(dir),
            input: `${REFUSED.join('\n')}\nhttps://API.example.test/app\n`,
        })
        assert.strictEqual(r.status, 0, r.out)
        for (const bad of REFUSED) {
            assert.match(r.out, new RegExp(`'${bad.replace('*', '\\*')}' is not a domain name`), bad)
        }
        assert.strictEqual(hostnames(dir).backend, 'api.example.test')
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('a blank answer skips the app, and nothing is published', () => {
    const dir = project()
    const r = tunnel(['start', '--yes'], { cwd: dir, env: credentials(dir), input: '\n\n' })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /nothing to publish/)
    assert.ok(!launched(dir))
})

test('setup asks for every missing hostname, saves them, and routes the DNS', () => {
    const dir = project()
    const home = path.join(dir, 'home', '.cloudflared')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cert.pem'), 'x')
    fs.writeFileSync(path.join(home, '11111111-2222-3333-4444-555555555555.json'), '{}')
    const r = tunnel(['setup'], {
        cwd: dir,
        env: { HOME: path.join(dir, 'home') },
        input: 'api.example.test\nshop.example.test\n',
    })
    assert.strictEqual(r.status, 0, r.out)
    assert.deepStrictEqual(hostnames(dir), { backend: 'api.example.test', storefront: 'shop.example.test' })
    assert.match(r.out, /nothing is public yet/)
    assert.strictEqual(cloudflaredCalls(dir).filter((a) => a.includes('route')).length, 2)
})

test('the ingress maps each hostname to its own app, and ends in the catch-all', async () => {
    const dir = project({
        tunnel: { name: 'demo', hostnames: { ...HOSTS.tunnel.hostnames, postgres: 'db.example.test' } },
    })
    const release = await serveApp(dir, 'storefront', PORTS.storefront)
    try {
        const r = tunnel(['start', '--yes'], { cwd: dir, env: credentials(dir) })
        assert.strictEqual(r.status, 0, r.out)
        const yml = fs.readFileSync(ingress(dir), 'utf8')
        assert.match(yml, new RegExp(`hostname: api\\.example\\.test\\n\\s+service: http://localhost:${PORTS.backend}\\n`))
        assert.match(yml, new RegExp(`hostname: shop\\.example\\.test\\n\\s+service: http://localhost:${PORTS.storefront}\\n`))
        assert.ok(yml.trimEnd().endsWith('- service: http_status:404'), 'cloudflare requires a catch-all last')
        assert.ok(!yml.includes('db.example.test'), 'a hostname for a non-app is never routed')
        assert.ok(!yml.includes(`localhost:${PORTS.postgres}`), 'only the resolved app ports are ever exposed')
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('start without tunnel credentials says so and launches nothing', () => {
    const dir = project(HOSTS)
    const r = tunnel(['start', 'backend', '--yes'], {
        cwd: dir,
        env: { XDG_CONFIG_HOME: path.join(dir, 'no-credentials-here') },
    })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /No named tunnel configured/)
    assert.ok(!launched(dir))
})

test('a cloudflared that dies on startup fails loudly and leaves no pid behind', async () => {
    const dir = project(HOSTS)
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        const r = tunnel(['quick', 'storefront', '--yes'], { cwd: dir, env: { LMA_TEST_CLOUDFLARED_DIE: '1' } })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /exited during startup/)
        assert.ok(!fs.existsSync(pidFile(dir)), 'a failed start must not leave a pid file')
        const again = tunnel(['quick', 'storefront', '--yes'], { cwd: dir })
        assert.strictEqual(again.status, 0, again.out)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('a tunnel killed from outside reads as not running, not as up', async () => {
    const dir = project(HOSTS)
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        assert.strictEqual(tunnel(['quick', 'storefront', '--yes'], { cwd: dir }).status, 0)
        const pid = Number(fs.readFileSync(pidFile(dir), 'utf8'))
        killQuietly(pid)
        for (let i = 0; alive(pid) && i < 50; i++) await new Promise((r) => setTimeout(r, 100))

        const r = tunnel(['status'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, /Not running \(nothing published\)/)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('setup survives a DNS record that already exists', () => {
    const dir = project(HOSTS)
    const home = path.join(dir, 'home', '.cloudflared')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'cert.pem'), 'x')
    fs.writeFileSync(path.join(home, '11111111-2222-3333-4444-555555555555.json'), '{}')
    const r = tunnel(['setup'], {
        cwd: dir,
        env: { HOME: path.join(dir, 'home'), LMA_TEST_ROUTE_FAIL: '1' },
    })
    assert.strictEqual(r.status, 0, 'an existing record is not a failure')
    assert.match(r.out, /could not create the DNS record/)
    assert.match(r.out, /nothing is public yet/)
})

test('quick --dry-run shows the banner and starts nothing', () => {
    const dir = project(HOSTS)
    const r = tunnel(['quick', 'storefront', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /going public/)
    assert.match(r.out, /development data only/)
    assert.ok(!launched(dir), 'a dry run must not start cloudflared')
})

test('the banner names the admin dashboard when the backend is published', () => {
    const dir = project(HOSTS)
    const r = tunnel(['quick', 'backend', '--dry-run'], { cwd: dir })
    assert.match(r.out, /includes the Admin dashboard at \/app/)
})

test('publishing the backend with a guessable admin password is refused', async () => {
    const dir = project({ ...HOSTS, admin: { email: 'admin@demo.local', password: 'medusa123' } })
    const release = await holdAppPort(dir, 'backend', PORTS.backend)
    try {
        const r = tunnel(['quick', 'backend', '--yes'], { cwd: dir })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /admin password is guessable/)
        assert.ok(!launched(dir), 'nothing may be published while the admin is guessable')
    } finally { await release() }
})

test('the weak-admin refusal can be overridden deliberately', async () => {
    const dir = project({ ...HOSTS, admin: { email: 'admin@demo.local', password: 'medusa123' } })
    const release = await holdAppPort(dir, 'backend', PORTS.backend)
    try {
        const r = tunnel(['quick', 'backend', '--yes'], {
            cwd: dir,
            env: { LMA_TUNNEL_ALLOW_WEAK_ADMIN: '1' },
        })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(launched(dir))
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('quick refuses to publish without a tty unless --yes is given', async () => {
    const dir = project(HOSTS)
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        const r = tunnel(['quick', 'storefront'], { cwd: dir })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /refusing to publish without a terminal/)
        assert.ok(!launched(dir))
    } finally { await release() }
})

test('a remembered acceptance republishes the same routes without a second prompt', async () => {
    const dir = project(HOSTS)
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        const first = tunnel(['quick', 'storefront', '--yes'], { cwd: dir })
        assert.strictEqual(first.status, 0, first.out)
        assert.match(first.out, /trycloudflare\.com/)
        assert.ok(launched(dir))

        const ack = path.join(dir, '.local-medusa-app', 'tunnel', 'exposure-ack')
        assert.ok(fs.existsSync(ack), 'the accepted route set is recorded')
        assert.strictEqual(fs.readFileSync(ack, 'utf8'), `quick|storefront=shop.example.test:${PORTS.storefront}`,
            'the port is part of what was agreed to, not just the name')

        const stopped = tunnel(['stop'], { cwd: dir })
        assert.strictEqual(stopped.status, 0, stopped.out)
        assert.match(stopped.out, /Tunnel stopped/)

        // same routes as before: no second prompt, and no tty to answer one
        const again = tunnel(['quick', 'storefront'], { cwd: dir })
        assert.strictEqual(again.status, 0, again.out)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

const rememberAck = (dir, value) => {
    fs.mkdirSync(path.join(dir, '.local-medusa-app', 'tunnel'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.local-medusa-app', 'tunnel', 'exposure-ack'), value)
}

test('a new hostname invalidates the remembered acceptance', async () => {
    const dir = project(HOSTS)
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        rememberAck(dir, `quick|storefront=old.example.test:${PORTS.storefront}`)
        const r = tunnel(['quick', 'storefront'], { cwd: dir })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /refusing to publish without a terminal/)
    } finally { await release() }
})

test('the same hostname over a different port invalidates it too', async () => {
    const dir = project(HOSTS)
    const release = await holdAppPort(dir, 'storefront', PORTS.storefront)
    try {
        rememberAck(dir, 'quick|storefront=shop.example.test:1234')
        const r = tunnel(['quick', 'storefront'], { cwd: dir })
        assert.notStrictEqual(r.status, 0, 'what is behind the name changed, so it must be asked again')
        assert.match(r.out, /refusing to publish without a terminal/)
    } finally { await release() }
})

test('tunnel start warns when the backend rejects the published origin', async () => {
    const dir = project(HOSTS)
    const release = await serveApp(dir, 'backend', PORTS.backend, {
        allowedHosts: ['api.example.test'],
        allowedOrigins: [],
    })
    try {
        const r = tunnel(['start', 'backend', '--yes'], { cwd: dir, env: credentials(dir) })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, /backend rejects Origin https:\/\/api\.example\.test \(ADMIN_CORS\)/)
        assert.match(r.out, /pick it up with: lma restart/)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('tunnel start stays quiet when the origin is already allowed', async () => {
    const dir = project(HOSTS)
    const release = await serveApp(dir, 'backend', PORTS.backend, {
        allowedHosts: ['api.example.test'],
        allowedOrigins: ['https://api.example.test'],
    })
    try {
        const r = tunnel(['start', 'backend', '--yes'], { cwd: dir, env: credentials(dir) })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(!/rejects Origin/.test(r.out), r.out)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

// a stale pid file must not read as "not running"
const orphanTunnel = (dir) => {
    fs.mkdirSync(path.join(dir, '.local-medusa-app', 'tunnel'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.local-medusa-app', 'tunnel', 'cloudflared.pid'), '999999')
    return daemon(dir, ['cloudflared', 'tunnel', '--config',
        path.join(dir, '.local-medusa-app', 'tunnel', 'config.yml'), 'run'])
}

test('an unrecorded tunnel is found and stopped, not reported as absent', async () => {
    const dir = project(HOSTS)
    const pid = orphanTunnel(dir)
    try {
        const status = tunnel(['status'], { cwd: dir })
        assert.match(status.out, /unrecorded cloudflared running for this project/)
        assert.ok(!/Not running/.test(status.out), 'it must not claim nothing is published')

        const stopped = tunnel(['stop'], { cwd: dir })
        assert.match(stopped.out, /found an unrecorded cloudflared/)
        assert.match(stopped.out, /Tunnel stopped/)
        assert.ok(!alive(pid), 'the orphan is gone')
    } finally { killQuietly(pid) }
})

test('start refuses to publish over an unrecorded tunnel', async () => {
    const dir = project(HOSTS)
    const pid = orphanTunnel(dir)
    const release = await holdAppPort(dir, 'backend', PORTS.backend)
    try {
        const r = tunnel(['start', 'backend', '--yes'], { cwd: dir, env: credentials(dir) })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.out, /serving whatever routes it started with/)
        assert.ok(!launched(dir), 'no second tunnel is started on top')
    } finally { killQuietly(pid); await release() }
})

test('stop leaves a reused pid alone instead of killing a stranger', () => {
    const dir = project(HOSTS)
    const pid = daemon(dir, ['nothing-to-do-with-tunnels'])
    try {
        const tunnelDir = path.join(dir, '.local-medusa-app', 'tunnel')
        fs.mkdirSync(tunnelDir, { recursive: true })
        fs.writeFileSync(path.join(tunnelDir, 'cloudflared.pid'), `${pid}\n`)
        const r = tunnel(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(alive(pid), 'an unrelated process must survive lma tunnel stop')
        assert.match(r.out, /is not this project's tunnel/)
    } finally { killQuietly(pid) }
})

test('status reports plainly when nothing is published', () => {
    const dir = project(HOSTS)
    const r = tunnel(['status'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /Not running \(nothing published\)/)
})
