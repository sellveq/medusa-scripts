// projects set CORS themselves, so lma may only ever add to it
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const cors = require('../lib/cors.js')
const envfile = require('../lib/envfile.js')
const { project, cleanup, local, devEnv, PORTS } = require('./support/harness.js')

test.after(cleanup)

const TUNNEL = { name: 'demo', hostnames: { storefront: 'shop.example.test', backend: 'api.example.test' } }
const ports = { http: 80, backend: 9000, storefront: 8000 }

test('the store origins are the front door, the storefront and its tunnel', () => {
    const { STORE_CORS } = cors.owned({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL }, ports)
    assert.deepStrictEqual(STORE_CORS,
        ['http://valadio.local', 'http://localhost:8000', 'https://shop.example.test'])
})

test('the admin origins are the front door, the backend and its tunnel', () => {
    const { ADMIN_CORS } = cors.owned({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL }, ports)
    assert.deepStrictEqual(ADMIN_CORS,
        ['http://valadio.local', 'http://localhost:9000', 'https://api.example.test'])
})

test('auth covers both, without repeating the front door', () => {
    const { AUTH_CORS } = cors.owned({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL }, ports)
    assert.deepStrictEqual(AUTH_CORS, [
        'http://valadio.local', 'http://localhost:8000', 'https://shop.example.test',
        'http://localhost:9000', 'https://api.example.test',
    ])
})

test('a non-default proxy port lands in the origin', () => {
    const { STORE_CORS } = cors.owned({ proxy: { domain: 'localhost' } }, { ...ports, http: 8080 })
    assert.ok(STORE_CORS.includes('http://localhost:8080'))
})

test('resolve appends to the app .env instead of replacing it', () => {
    const out = cors.resolve({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL }, ports, {
        appEnv: { STORE_CORS: 'http://mine.test,http://other.test' },
    })
    assert.strictEqual(out.STORE_CORS,
        'http://mine.test,http://other.test,http://valadio.local,http://localhost:8000,https://shop.example.test')
})

test('the environment leads, then the app .env, then lma', () => {
    const out = cors.resolve({ proxy: { domain: 'valadio.local' } }, ports, {
        env: { STORE_CORS: 'http://from-env.test' },
        appEnv: { STORE_CORS: 'http://from-file.test' },
    })
    assert.strictEqual(out.STORE_CORS.split(',')[0], 'http://from-env.test')
    assert.strictEqual(out.STORE_CORS.split(',')[1], 'http://from-file.test')
})

test('an origin already present is not repeated', () => {
    const out = cors.resolve({ proxy: { domain: 'valadio.local' } }, ports, {
        appEnv: { STORE_CORS: 'http://valadio.local' },
    })
    assert.strictEqual(out.STORE_CORS.split(',').filter((o) => o === 'http://valadio.local').length, 1)
})

test('missing() reports only what is not covered yet', () => {
    const cfg = { proxy: { domain: 'valadio.local' }, tunnel: TUNNEL }
    assert.deepStrictEqual(
        cors.missing('http://valadio.local,http://localhost:8000', cfg, ports, 'STORE_CORS'),
        ['https://shop.example.test']
    )
})


test('the env reader handles quotes, export and trailing comments', () => {
    const parsed = envfile.parse([
        'STORE_CORS=http://a.test,http://b.test',
        'ADMIN_CORS="http://c.test"',
        "AUTH_CORS='http://d.test'",
        'export JWT_SECRET=abc # inline note',
        '# a comment',
        'MALFORMED',
    ].join('\n'))
    assert.strictEqual(parsed.STORE_CORS, 'http://a.test,http://b.test')
    assert.strictEqual(parsed.ADMIN_CORS, 'http://c.test')
    assert.strictEqual(parsed.AUTH_CORS, 'http://d.test')
    assert.strictEqual(parsed.JWT_SECRET, 'abc')
    assert.strictEqual(parsed.MALFORMED, undefined)
})

test('a missing env file reads as empty, not an error', () => {
    assert.deepStrictEqual(envfile.read('/nope/definitely/not/here/.env'), {})
})


const withBackend = (config) => {
    const dir = project(config)
    fs.mkdirSync(path.join(dir, 'apps', 'backend'), { recursive: true })
    return dir
}

test('start hands the backend CORS covering the proxy and both apps', () => {
    const dir = withBackend()
    local(['start'], { cwd: dir })
    const env = devEnv(dir, 'backend')
    assert.ok(env.STORE_CORS.includes(`http://localhost:${PORTS.storefront}`))
    assert.ok(env.ADMIN_CORS.includes(`http://localhost:${PORTS.backend}`))
    assert.ok(env.AUTH_CORS.includes(`http://localhost:${PORTS.storefront}`))
    assert.ok(env.AUTH_CORS.includes(`http://localhost:${PORTS.backend}`))
})

test('the tunnel origins are there before the tunnel ever runs', () => {
    const dir = withBackend({ proxy: { domain: 'valadio.local' }, tunnel: TUNNEL })
    local(['start'], { cwd: dir })
    const env = devEnv(dir, 'backend')
    assert.ok(env.STORE_CORS.includes('https://shop.example.test'), env.STORE_CORS)
    assert.ok(env.ADMIN_CORS.includes('https://api.example.test'), env.ADMIN_CORS)
    assert.ok(env.AUTH_CORS.includes('https://shop.example.test'))
    assert.ok(env.AUTH_CORS.includes('https://api.example.test'))
})

test('origins written in the backend .env are kept, not overwritten', () => {
    const dir = withBackend({ tunnel: TUNNEL })
    fs.writeFileSync(
        path.join(dir, 'apps', 'backend', '.env'),
        'STORE_CORS=http://keep-me.test\nADMIN_CORS=http://keep-admin.test\n'
    )
    local(['start'], { cwd: dir })
    const env = devEnv(dir, 'backend')
    assert.ok(env.STORE_CORS.startsWith('http://keep-me.test'), env.STORE_CORS)
    assert.ok(env.STORE_CORS.includes('https://shop.example.test'))
    assert.ok(env.ADMIN_CORS.startsWith('http://keep-admin.test'), env.ADMIN_CORS)
    assert.ok(env.ADMIN_CORS.includes('https://api.example.test'))
})

test('start --dry-run shows the CORS it would set', () => {
    const dir = withBackend({ tunnel: TUNNEL })
    const r = local(['start', '--dry-run'], { cwd: dir })
    assert.match(r.out, /\[dry-run\] STORE_CORS=.*https:\/\/shop\.example\.test/)
    assert.match(r.out, /\[dry-run\] ADMIN_CORS=.*https:\/\/api\.example\.test/)
    assert.match(r.out, /\[dry-run\] AUTH_CORS=/)
})

test('show-env prints the effective CORS and says it is automatic', () => {
    const r = local(['show-env'], { cwd: project({ tunnel: TUNNEL }) })
    assert.match(r.out, /^STORE_CORS=.*https:\/\/shop\.example\.test$/m)
    assert.match(r.out, /^ADMIN_CORS=.*https:\/\/api\.example\.test$/m)
    assert.match(r.out, /merged with your \.env/)
})
