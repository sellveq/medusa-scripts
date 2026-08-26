// the everyday path
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const images = require('../lib/images.js')
const { project, cleanup, local, ranDocker, composeImages, daemon, alive, killQuietly, started, sleep, PORTS } = require('./support/harness.js')

test.after(cleanup)

test('start --dry-run describes the whole plan and runs none of it', () => {
    const dir = project()
    const r = local(['start', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\] docker compose .* up -d/)
    assert.strictEqual(r.stderr.trim(), '')
    assert.ok(!ranDocker(dir, 'compose'), 'nothing reaches docker')
})

test('start --dry-run lists the dev servers it would launch', () => {
    const dir = project()
    for (const app of ['apps/backend', 'apps/storefront']) fs.mkdirSync(path.join(dir, app), { recursive: true })
    const r = local(['start', '--dry-run'], { cwd: dir })
    assert.match(r.out, new RegExp(`\\[dry-run\\] cd apps/backend && npm run dev \\(PORT=${PORTS.backend}\\)`))
    assert.match(r.out, new RegExp(`\\[dry-run\\] cd apps/storefront && npm run dev \\(PORT=${PORTS.storefront}\\)`))
})

test('start brings up the infra and reports the addresses', () => {
    const dir = project()
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'up', '-d'))
    assert.match(r.out, /all services healthy/)
    assert.match(r.out, new RegExp(`storefront: http://localhost:${PORTS.http}`))
    assert.match(r.out, new RegExp(`admin: +http://localhost:${PORTS.http}/app`))
})

test('compose is handed the digest-pinned images', () => {
    const dir = project()
    local(['start'], { cwd: dir })
    const used = composeImages(dir)
    assert.strictEqual(used.LMA_POSTGRES_IMAGE, images.pinned('postgres'))
    assert.strictEqual(used.LMA_REDIS_IMAGE, images.pinned('redis'))
    assert.strictEqual(used.LMA_PROXY_IMAGE, images.pinned('proxy'))
})

test('a config override reaches compose, with a warning when it is loose', () => {
    const dir = project({ services: { postgres: { image: 'postgres:latest' } } })
    const r = local(['start'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.strictEqual(composeImages(dir).LMA_POSTGRES_IMAGE, 'postgres:latest')
    assert.match(r.out, /image pin warning: postgres: .*moves under you/)
})

test('the compose file itself carries pinned defaults, not floating tags', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', 'assets', 'docker-compose.yml'), 'utf8')
    const defaults = [...compose.matchAll(/image: \$\{LMA_\w+:-([^}]+)\}/g)].map((m) => m[1])
    assert.strictEqual(defaults.length, 3)
    for (const ref of defaults) assert.match(ref, /@sha256:[0-9a-f]{64}$/)
})

test('start refuses to guess when docker is not running and cannot be asked', () => {
    const dir = project()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_DOCKER_DOWN: '1' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Docker is not running, and there is no terminal to ask on/)
    assert.ok(!ranDocker(dir, 'compose'))
})

test('stop leaves a reused pid alone instead of killing a stranger', () => {
    const dir = project()
    const pid = daemon(dir, ['nothing-to-do-with-medusa'])
    try {
        const run = path.join(dir, '.local-medusa-app', 'run')
        fs.mkdirSync(run, { recursive: true })
        fs.writeFileSync(path.join(run, 'backend.pid'), `${pid}\n`)
        fs.writeFileSync(path.join(run, 'backend.id'), 'Wed Jan  1 00:00:00 2020\n')
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.ok(alive(pid), 'an unrelated process must survive lma stop')
        assert.match(r.out, /is not the backend we started/)
        assert.ok(!fs.existsSync(path.join(run, 'backend.pid')), 'the stale record is cleared')
    } finally { killQuietly(pid) }
})

test('stop does kill the process whose recorded identity still matches', () => {
    const dir = project()
    const pid = daemon(dir, ['pretend-dev-server'])
    try {
        const run = path.join(dir, '.local-medusa-app', 'run')
        fs.mkdirSync(run, { recursive: true })
        fs.writeFileSync(path.join(run, 'backend.pid'), `${pid}\n`)
        fs.writeFileSync(path.join(run, 'backend.id'), started(pid))
        const r = local(['stop'], { cwd: dir })
        assert.strictEqual(r.status, 0, r.out)
        assert.match(r.out, new RegExp(`stopping backend \\(pid ${pid}\\)`))
        for (let i = 0; alive(pid) && i < 50; i++) sleep(100)
        assert.ok(!alive(pid), 'the real thing must still be stopped')
    } finally { killQuietly(pid) }
})

test('show-env prints the connection strings for the backend', () => {
    const dir = project()
    const r = local(['show-env'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, new RegExp(`^DATABASE_URL=postgres://demo:demo@localhost:${PORTS.postgres}/demo_db$`, 'm'))
    assert.match(r.out, new RegExp(`^REDIS_URL=redis://localhost:${PORTS.redis}$`, 'm'))
})

test('help works before there is any config to read', () => {
    const dir = project()
    fs.rmSync(path.join(dir, 'lma.js'))
    const r = local(['help'], { cwd: dir, env: { LMA_ROOT: '' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /lma init/)
})

test('help documents the safety flags', () => {
    const r = local(['help'], { cwd: project() })
    assert.match(r.out, /--dry-run +print what would happen, change nothing/)
    assert.match(r.out, /--yes +skip the confirmation prompt/)
    assert.match(r.out, /secrets, dumps and pids live in \.local-medusa-app\//)
    assert.match(r.out, /ports and logs in\s+node_modules\/\.local-medusa-app-cache\//)
})
