// vite 403s any Host it was not told about; lma supplies the list
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const hosts = require('../lib/hosts.js')
const { project, cleanup, local, tunnel, devEnv, serveApp, PORTS } = require('./support/harness.js')

test.after(cleanup)

const TUNNEL = { name: 'demo', hostnames: { storefront: 'shop.example.test', backend: 'api.example.test' } }

test('localhost needs nothing: Vite allows it already', () => {
    assert.deepStrictEqual(hosts.adminAllowedHosts({ proxy: { domain: 'localhost' } }), [])
    assert.deepStrictEqual(hosts.adminAllowedHosts({ proxy: { domain: '127.0.0.1' } }), [])
    assert.deepStrictEqual(hosts.adminAllowedHosts({ proxy: { domain: 'shop.localhost' } }), [])
})

test('a custom proxy domain and every tunnel hostname are collected', () => {
    assert.deepStrictEqual(
        hosts.adminAllowedHosts({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL }),
        ['valadio.local', 'shop.example.test', 'api.example.test']
    )
})

test('proxy.allowedHosts adds extras, and a wildcard is kept verbatim', () => {
    assert.deepStrictEqual(
        hosts.adminAllowedHosts({ proxy: { domain: 'valadio.local', allowedHosts: ['.ngrok.app', 'localhost'] } }),
        ['valadio.local', '.ngrok.app']
    )
})

test('duplicates and stray ports collapse', () => {
    assert.deepStrictEqual(
        hosts.adminAllowedHosts({
            proxy: { domain: 'valadio.local', allowedHosts: ['valadio.local:8080'] },
            tunnel: { hostnames: { backend: 'valadio.local' } },
        }),
        ['valadio.local']
    )
})

test('an inherited value is merged, never replaced', () => {
    assert.deepStrictEqual(hosts.merge('mine.test, other.test', ['valadio.local']),
        ['mine.test', 'other.test', 'valadio.local'])
    assert.deepStrictEqual(hosts.merge('', ['a.test']), ['a.test'])
    assert.deepStrictEqual(hosts.merge('a.test', ['a.test']), ['a.test'])
})


const withBackend = (config) => {
    const dir = project(config)
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    return dir
}

test('a localhost project passes no allowed hosts at all', () => {
    const dir = withBackend()
    local(['start'], { cwd: dir })
    assert.strictEqual(devEnv(dir, 'backend').__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS, undefined)
})

test('start passes the proxy domain to the admin dev server', () => {
    const dir = withBackend({ proxy: { domain: 'valadio.local' } })
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.strictEqual(devEnv(dir, 'backend').__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS, 'valadio.local')
})

test('the tunnel hostnames go in at start, so tunnel start needs no restart', () => {
    const dir = withBackend({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL })
    local(['start'], { cwd: dir })
    assert.strictEqual(
        devEnv(dir, 'backend').__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS,
        'valadio.local,shop.example.test,api.example.test'
    )
})

test('a backend with its own .env keeps owning it, bar the two lma fills in', () => {
    const dir = withBackend({ proxy: { domain: 'valadio.local' } })
    fs.writeFileSync(path.join(dir, 'apps', 'backend', '.env'), 'DATABASE_URL=postgres://mine/db\n')
    local(['start'], { cwd: dir })
    const env = devEnv(dir, 'backend')
    assert.strictEqual(env.__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS, 'valadio.local')
    assert.ok(env.STORE_CORS.includes('http://valadio.local'), 'CORS is filled in too')
    assert.strictEqual(env.DATABASE_URL, undefined, 'everything else is still the app\'s')
    assert.strictEqual(env.JWT_SECRET, undefined)
})

test('a host set in the environment survives alongside the configured ones', () => {
    const dir = withBackend({ proxy: { domain: 'valadio.local' } })
    local(['start'], { cwd: dir, env: { __MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS: 'mine.test' } })
    assert.strictEqual(
        devEnv(dir, 'backend').__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS,
        'mine.test,valadio.local'
    )
})

test('start --dry-run says which hosts it would allow', () => {
    const dir = withBackend({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL })
    const r = local(['start', '--dry-run'], { cwd: dir })
    assert.match(r.out, /\[dry-run\] __MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS=valadio\.local,shop\.example\.test,api\.example\.test/)
})

test('show-env lists it for reference, and omits it on localhost', () => {
    const custom = local(['show-env'], { cwd: project({ proxy: { domain: 'valadio.local' } }) })
    assert.match(custom.out, /^__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS=valadio\.local$/m)
    assert.match(custom.out, /set on every 'lma start'/)

    const plain = local(['show-env'], { cwd: project() })
    assert.ok(!/__MEDUSA_ADMIN/.test(plain.out))
})


const credentials = (dir) => {
    const creds = path.join(dir, 'config', 'local-medusa-app', 'tunnels')
    fs.mkdirSync(creds, { recursive: true })
    fs.writeFileSync(path.join(creds, 'demo.json'), '{"AccountTag":"test"}')
    return { XDG_CONFIG_HOME: path.join(dir, 'config') }
}

test('tunnel start warns when the admin refuses the published hostname', async () => {
    const dir = project({ tunnel: TUNNEL })
    const release = await serveApp(dir, 'backend', PORTS.backend, { allowedHosts: [] })
    try {
        const r = tunnel(['start', 'backend', '--yes'], { cwd: dir, env: credentials(dir) })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, /admin dev server refuses Host: api\.example\.test/)
        assert.match(r.out, /pick it up with: lma restart/)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})

test('tunnel start stays quiet when the admin already accepts it', async () => {
    const dir = project({ tunnel: TUNNEL })
    const release = await serveApp(dir, 'backend', PORTS.backend, { allowedHosts: ['api.example.test'] })
    try {
        const r = tunnel(['start', 'backend', '--yes'], { cwd: dir, env: credentials(dir) })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(!/refuses Host/.test(r.out), r.out)
    } finally {
        tunnel(['stop'], { cwd: dir })
        await release()
    }
})
