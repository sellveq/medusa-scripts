// `lma admin` prints credentials; `lma seed-admin` makes them true
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { project, cleanup, local } = require('./support/harness.js')

test.after(cleanup)

// LMA_TEST_ADMIN_COUNT: admins in the database
// LMA_TEST_ADMIN_MATCHES: 1 when the configured email is one of them
const db = (count, matches, others = '') => ({
    LMA_TEST_ADMIN_COUNT: String(count),
    LMA_TEST_ADMIN_MATCHES: String(matches),
    LMA_TEST_OTHER_ADMINS: others,
})

test('admin says plainly when the configured account does not exist', () => {
    const dir = project()
    const r = local(['admin'], { cwd: dir, env: db(1, 0, 'someone@else.test') })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /no user 'admin@demo\.local' in the database, so this password logs in nowhere/)
    assert.match(r.out, /create it with: +lma seed-admin/)
    assert.match(r.out, /existing admin accounts: someone@else\.test/)
})

test('admin confirms an account lma seeded itself', () => {
    const dir = project()
    fs.mkdirSync(path.join(dir, '.local-medusa-app'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.local-medusa-app', 'seeded-admin'), 'admin@demo.local\n')
    const r = local(['admin'], { cwd: dir, env: db(1, 1) })
    assert.match(r.out, /lma created it with this password/)
})

test('admin hedges on an account it did not create', () => {
    const r = local(['admin'], { cwd: project(), env: db(1, 1) })
    assert.match(r.out, /lma did not create it/)
    assert.match(r.out, /only right if it was set with it/)
})

test('admin does not pretend to have checked when docker is down', () => {
    const r = local(['admin'], { cwd: project(), env: { LMA_TEST_DOCKER_DOWN: '1' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /not verified/)
})

test('seed-admin creates the configured account even when other admins exist', () => {
    const dir = project()
    const r = local(['seed-admin'], { cwd: dir, env: db(3, 0) })
    assert.match(r.out, /the database has 3 admin\(s\), but not admin@demo\.local; creating it/)
})

test('seed-admin skips when the configured account is already there', () => {
    const dir = project()
    const r = local(['seed-admin'], { cwd: dir, env: db(3, 1) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /admin@demo\.local already exists; seed skipped/)
    assert.ok(!/creating it/.test(r.out))
})

test('seed-admin still reports an unmigrated database', () => {
    const dir = project()
    const r = local(['seed-admin'], { cwd: dir, env: { LMA_TEST_ADMIN_COUNT: '' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /no user table yet\. Run: lma migrate/)
})

test('start does not stop at an unmigrated database', () => {
    const dir = project()
    const r = local(['start'], { cwd: dir, env: { LMA_TEST_ADMIN_COUNT: '' } })
    assert.strictEqual(r.status, 0, r.out)
})

test('an email with a quote in it cannot break the query', () => {
    const dir = project({ admin: { email: "o'brien@demo.local" } })
    const r = local(['admin'], { cwd: dir, env: db(1, 0) })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /o'brien@demo\.local/)
})
