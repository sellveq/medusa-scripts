// config discovery and the port allocator
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const config = require('../lib/config.js')
const confedit = require('../lib/confedit.js')
const ports = require('../lib/ports.js')
const images = require('../lib/images.js')
const { project, cleanup, PORTS } = require('./support/harness.js')

test.after(cleanup)

test('slug survives anything a directory name can hold', () => {
    assert.strictEqual(config.slug('My Shop'), 'my-shop')
    assert.strictEqual(config.slug('@scope/pkg_v2'), 'scope-pkg-v2')
    assert.strictEqual(config.slug('---'), '')
})

test('the project name is slugged, so compose cannot split the stack', () => {
    const dir = project({ project: 'My Shop' })
    assert.strictEqual(config.project(dir, config.load(dir)), 'my-shop')
})

test('the config is found from any subdirectory', () => {
    const dir = project()
    const deep = path.join(dir, 'apps', 'backend', 'src')
    fs.mkdirSync(deep, { recursive: true })
    assert.strictEqual(config.findRoot(deep), dir)
})

test('an ESM project must name its config .cjs, and is told so', () => {
    const dir = project({}, { type: 'module' })
    assert.strictEqual(config.configName(dir), 'lma.cjs')
    assert.strictEqual(config.configPath(dir), path.join(dir, 'lma.cjs'))

    fs.rmSync(path.join(dir, 'lma.cjs'))
    fs.writeFileSync(path.join(dir, 'lma.js'), 'module.exports = { project: "x" }\n')
    assert.throws(() => config.load(dir), /Rename it to lma\.cjs/)
})

test('a config that exports nothing fails loudly', () => {
    const dir = project()
    fs.writeFileSync(path.join(dir, 'lma.js'), 'module.exports = {}\n')
    assert.throws(() => config.load(dir), /exported no config/)
})

const written = (dir, src) => {
    fs.writeFileSync(path.join(dir, 'lma.js'), src)
    return dir
}

test('hostnames are added to an existing tunnel block, at its indentation', () => {
    const dir = written(project(), [
        'module.exports = {',
        "    project: 'demo',",
        '    tunnel: {',
        "        name: 'demo',",
        '    },',
        '}',
        '',
    ].join('\n'))
    confedit.setHostnames(dir, { backend: 'api.example.test' })
    const src = fs.readFileSync(path.join(dir, 'lma.js'), 'utf8')
    assert.match(src, /\n {8}hostnames: \{\n {12}backend: 'api\.example\.test',\n {8}\},\n/)
    assert.match(src, /name: 'demo'/, 'the rest of the block is untouched')
})

test('a second hostname joins the first instead of replacing it', () => {
    const dir = project()
    confedit.setHostnames(dir, { backend: 'api.example.test' })
    confedit.setHostnames(dir, { storefront: 'shop.example.test' })
    assert.deepStrictEqual(config.load(dir).tunnel.hostnames, {
        backend: 'api.example.test',
        storefront: 'shop.example.test',
    })
})

test('a config with no tunnel key gets one', () => {
    const dir = written(project(), "module.exports = {\n    project: 'demo',\n}\n")
    confedit.setHostnames(dir, { backend: 'api.example.test' })
    assert.deepStrictEqual(config.load(dir).tunnel.hostnames, { backend: 'api.example.test' })
})

test('a hostname that could not be written back leaves the file as it was', () => {
    const dir = project()
    const before = fs.readFileSync(path.join(dir, 'lma.js'), 'utf8')
    assert.throws(() => confedit.setHostnames(dir, { backend: "x'; process.exit(1); //" }), /not a hostname/)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'lma.js'), 'utf8'), before)
})

test('ports fall back to the preferred value when it is free', async () => {
    const { ports: p, bases } = await ports.resolve(project())
    assert.strictEqual(p.postgres, bases.postgres)
    assert.strictEqual(p.redis, bases.redis)
})

test('a busy port moves the service to the next free one', async () => {
    const dir = project()
    const srv = net.createServer()
    await new Promise((res) => srv.listen(PORTS.postgres, '127.0.0.1', res))
    try {
        const { ports: p } = await ports.resolve(dir)
        assert.strictEqual(p.postgres, PORTS.postgres + 1, 'moved up by one')
    } finally { await new Promise((res) => srv.close(res)) }
})

test('an allocation is pinned until --reset', async () => {
    const dir = project()
    const first = await ports.resolve(dir)
    assert.deepStrictEqual((await ports.resolve(dir)).ports, first.ports)
    const reset = await ports.resolve(dir, { reset: true })
    assert.deepStrictEqual(reset.ports, first.ports, 'a reset with nothing in the way is a no-op')
})

test('two services never land on the same port', async () => {
    const dir = project({ services: { postgres: { port: 57000 }, redis: { port: 57000 } } })
    const { ports: p } = await ports.resolve(dir)
    assert.notStrictEqual(p.postgres, p.redis)
})

test('projects in different directories get different container names', () => {
    const a = project()
    const b = project()
    assert.notStrictEqual(ports.projectName(a), ports.projectName(b))
    assert.match(ports.projectName(a), /^demo-\d+$/)
})

test('every infra image is pinned to a tag and a digest', () => {
    for (const service of ['postgres', 'redis', 'proxy']) {
        const ref = images.pinned(service)
        assert.match(ref, /^[a-z]+:\d+\.\d+(\.\d+)?-alpine@sha256:[0-9a-f]{64}$/, `${service}: ${ref}`)
        assert.deepStrictEqual(images.validate(service, ref), [])
    }
})

test('an override that could move under you is called out', () => {
    assert.match(images.validate('postgres', 'postgres:latest')[0], /moves under you/)
    assert.match(images.validate('postgres', 'postgres')[0], /has no tag/)
    assert.deepStrictEqual(images.validate('postgres', 'ghcr.io/me/pg:16.15'), [])
})

test('a config override replaces the pin but still warns when it is loose', () => {
    const warnings = []
    const resolved = images.all({ services: { postgres: { image: 'postgres:latest' } } }, (m) => warnings.push(m))
    assert.strictEqual(resolved.postgres, 'postgres:latest')
    assert.strictEqual(resolved.redis, images.pinned('redis'))
    assert.match(warnings.join(), /postgres: .*moves under you/)
})
