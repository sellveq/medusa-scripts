// state is split by what it costs to lose
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const paths = require('../lib/paths.js')
const secrets = require('../lib/secrets.js')
const ports = require('../lib/ports.js')
const { project, cleanup, local, PORTS } = require('./support/harness.js')

test.after(cleanup)

test('state lives in .local-medusa-app at the project root', () => {
    const dir = project()
    assert.strictEqual(paths.ensure(dir), path.join(dir, '.local-medusa-app'))
    assert.ok(fs.existsSync(path.join(dir, '.local-medusa-app')))
})

test('.local-medusa-app ignores itself, so no project .gitignore has to change', () => {
    const dir = project()
    paths.ensure(dir)
    assert.strictEqual(fs.readFileSync(path.join(dir, '.local-medusa-app', '.gitignore'), 'utf8'), '*\n')
    assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), 'the project .gitignore is left alone')
})

const state = (dir, ...p) => path.join(dir, '.local-medusa-app', ...p)
const cache = (dir, ...p) => path.join(dir, 'node_modules', '.local-medusa-app-cache', ...p)

test('the port map and the logs live in the install cache', () => {
    const dir = project()
    paths.ensure(dir)
    assert.strictEqual(paths.cacheDir(dir), cache(dir))
    assert.strictEqual(ports.cachePath(dir), cache(dir, 'ports.json'))
    assert.ok(fs.existsSync(cache(dir)))
})

test('secrets, dumps and pids stay out of node_modules', () => {
    const dir = project()
    assert.strictEqual(path.dirname(secrets.ensure(dir).file), state(dir))
    assert.ok(!secrets.ensure(dir).file.includes('node_modules'), 'a wiped install must not take them')
})

test('the port map is pinned in the cache until --reset', async () => {
    const dir = project()
    const first = await ports.resolve(dir)
    assert.ok(fs.existsSync(cache(dir, 'ports.json')))
    assert.deepStrictEqual((await ports.resolve(dir)).ports, first.ports)
})

test('a wiped node_modules costs the port map, never the secrets', async () => {
    const dir = project()
    const before = secrets.ensure(dir).values.LMA_ADMIN_PASSWORD
    await ports.resolve(dir)
    assert.ok(fs.existsSync(cache(dir, 'ports.json')))

    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })

    assert.strictEqual(secrets.ensure(dir).values.LMA_ADMIN_PASSWORD, before, 'the admin login survives')
    assert.ok(fs.existsSync(state(dir, 'secrets.env')))
})

test('secrets are generated once, kept private, and reused', () => {
    const dir = project()
    const first = secrets.ensure(dir)
    assert.strictEqual(path.basename(first.file), 'secrets.env')
    assert.strictEqual(fs.statSync(first.file).mode & 0o777, 0o600)
    for (const k of ['LMA_JWT_SECRET', 'LMA_COOKIE_SECRET', 'LMA_ADMIN_PASSWORD']) {
        assert.ok(first.values[k], `${k} is generated`)
    }
    const second = secrets.ensure(dir)
    assert.deepStrictEqual(second.values, first.values, 'a second run must not rotate them')
})

test('the generated admin password is strong and not reused across projects', () => {
    const a = secrets.ensure(project()).values.LMA_ADMIN_PASSWORD
    const b = secrets.ensure(project()).values.LMA_ADMIN_PASSWORD
    assert.notStrictEqual(a, b)
    assert.ok(a.length >= 16, 'long enough to survive being on the public internet by accident')
    assert.ok(!secrets.isWeak(a))
})

test('the known-bad passwords are still recognised as weak', () => {
    for (const pw of ['medusa123', 'MEDUSA123', 'password', 'admin', 'supersecret', '', 'short']) {
        assert.ok(secrets.isWeak(pw), `${pw} must count as weak`)
    }
})

test('a missing admin password falls back to the generated one', () => {
    const dir = project()
    const r = local(['admin'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /from \.local-medusa-app\/secrets\.env/)
    const generated = secrets.ensure(dir).values.LMA_ADMIN_PASSWORD
    assert.ok(r.out.includes(generated), 'lma admin prints the password it will actually seed')
})

test('a configured admin password wins, and a weak one is called out', () => {
    const dir = project({ admin: { email: 'admin@demo.local', password: 'medusa123' } })
    const r = local(['admin'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /password: medusa123/)
    assert.match(r.out, /guessable/)
})

test('LMA_ADMIN_PASSWORD from the environment wins over both', () => {
    const dir = project({ admin: { email: 'admin@demo.local', password: 'from-config-x' } })
    const r = local(['admin'], { cwd: dir, env: { LMA_ADMIN_PASSWORD: 'from-the-environment' } })
    assert.match(r.out, /password: from-the-environment/)
    assert.match(r.out, /from env LMA_ADMIN_PASSWORD/)
})
