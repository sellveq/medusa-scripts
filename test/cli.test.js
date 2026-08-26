// init must be safe to run twice, and inside a project with its own scripts
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cli, cleanup } = require('./support/harness.js')

const roots = []
test.after(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); cleanup() })

const blank = (pkg = { name: 'shop', version: '1.0.0' }) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lma-init-')))
    roots.push(dir)
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    return dir
}

test('--version reports the package and the node it runs on', () => {
    const r = cli(['--version'], { cwd: blank() })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /@selveq\/medusa-scripts \d+\.\d+\.\d+ \(node \d+\./)
})

test('help works before init', () => {
    const r = cli(['help'], { cwd: blank() })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /lma init/)
})

test('a command outside a project explains what to do', () => {
    const r = cli(['status'], { cwd: blank() })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /Run 'lma init' in your project root first/)
})

test('init scaffolds a config, the state dir and one npm alias', () => {
    const dir = blank()
    const r = cli(['init'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(path.join(dir, 'lma.js')))
    assert.ok(fs.existsSync(path.join(dir, '.local-medusa-app', '.gitignore')))
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.lma, 'lma')
})

test('init ships no password in the config and prints a generated one', () => {
    const dir = blank()
    const r = cli(['init'], { cwd: dir })
    const config = fs.readFileSync(path.join(dir, 'lma.js'), 'utf8')
    assert.ok(!/medusa123/.test(config), 'the old shared default must be gone')
    assert.ok(!/password:\s*'[^']+'/.test(config.split('admin:')[1].split('},')[0]), 'admin block ships no password')
    const printed = r.out.match(/Admin login \(generated, local only\): \S+ \/ (\S+)/)
    assert.ok(printed, `expected the generated login in:\n${r.out}`)
    const secrets = fs.readFileSync(path.join(dir, '.local-medusa-app', 'secrets.env'), 'utf8')
    assert.ok(secrets.includes(printed[1]), 'the printed password is the stored one')
})

test('init keeps a config that is already there', () => {
    const dir = blank()
    cli(['init'], { cwd: dir })
    fs.appendFileSync(path.join(dir, 'lma.js'), '// hand-edited\n')
    const r = cli(['init'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /kept +lma\.js/)
    assert.match(fs.readFileSync(path.join(dir, 'lma.js'), 'utf8'), /hand-edited/)
})

test('init never overwrites a script the project already defines', () => {
    const dir = blank({ name: 'shop', version: '1.0.0', scripts: { start: 'turbo run start', lma: 'echo mine' } })
    const r = cli(['init', '--scripts'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    const { scripts } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    assert.strictEqual(scripts.start, 'turbo run start', 'yours win')
    assert.strictEqual(scripts.lma, 'echo mine')
    assert.strictEqual(scripts.psql, 'lma psql', 'the rest are still added')
    assert.match(r.out, /yours win: lma, start/)
})

test('init --no-scripts leaves package.json alone', () => {
    const dir = blank()
    const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    cli(['init', '--no-scripts'], { cwd: dir })
    assert.strictEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before)
})

test('an ESM project gets lma.cjs, because the config is CommonJS', () => {
    const dir = blank({ name: 'shop', version: '1.0.0', type: 'module' })
    const r = cli(['init'], { cwd: dir })
    assert.ok(fs.existsSync(path.join(dir, 'lma.cjs')))
    assert.ok(!fs.existsSync(path.join(dir, 'lma.js')))
    assert.match(r.out, /type": "module/)
})

test('a broken package.json is reported, not rewritten', () => {
    const dir = blank(null)
    fs.writeFileSync(path.join(dir, 'package.json'), '{ this is not json')
    const r = cli(['init'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /skipped +package\.json/)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), '{ this is not json')
})

test('ports prints the allocated map and where it is pinned', () => {
    const dir = blank()
    cli(['init'], { cwd: dir })
    const r = cli(['ports'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /postgres +\d+/)
    assert.match(r.out, /cache: .*node_modules\/\.local-medusa-app-cache\/ports\.json/)
})
