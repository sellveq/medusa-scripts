// commands that can lose data; assert on what reached docker, not the exit code
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { project, cleanup, local, ranDocker, dockerCalls } = require('./support/harness.js')

test.after(cleanup)

test('destroy refuses without a tty and leaves the volumes alone', () => {
    const dir = project()
    const r = local(['destroy'], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /refusing to continue without a terminal/)
    assert.ok(!ranDocker(dir, 'compose', 'down'), 'compose down must not run')
})

test('destroy takes the wrong confirmation word as no', () => {
    const dir = project()
    const r = local(['destroy'], { cwd: dir, input: 'yes\n' })
    assert.notStrictEqual(r.status, 0)
    assert.ok(!ranDocker(dir, 'compose', 'down'))
})

test('destroy --yes removes containers and volumes', () => {
    const dir = project()
    const r = local(['destroy', '--yes'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'down', '-v'), 'expected: compose down -v')
})

test('destroy --dry-run touches nothing', () => {
    const dir = project()
    const r = local(['destroy', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\].*down -v/s)
    assert.ok(!ranDocker(dir, 'compose', 'down'), 'a dry run must not call docker compose')
})

test('reset-db refuses without a tty when the database has tables', () => {
    const dir = project()
    const r = local(['db:reset'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '42' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /42 tables/)
    assert.ok(!dropRan(dir), 'DROP DATABASE must not run')
})

test('reset-db skips the prompt when the database is empty', () => {
    const dir = project()
    const r = local(['db:reset'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '0' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(dropRan(dir), 'an empty database is recreated without asking')
})

test('reset-db skips the prompt when the database does not exist yet', () => {
    const dir = project()
    const r = local(['db:reset'], { cwd: dir, env: { LMA_TEST_DB_EXISTS: '0' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(dropRan(dir))
})

test('reset-db --dry-run does not drop', () => {
    const dir = project()
    const r = local(['db:reset', '--dry-run'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '42' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\].*DROP DATABASE/)
    assert.ok(!dropRan(dir))
})

test('reset-db -y drops without asking', () => {
    const dir = project()
    const r = local(['db:reset', '-y'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '42' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(dropRan(dir))
})

test('import-db rejects a missing file before dropping anything', () => {
    const dir = project()
    const r = local(['db:import', path.join(dir, 'nope.sql')], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /usage: lma import-db/)
    assert.ok(!dropRan(dir), 'the drop must come after the file check')
})

test('import-db refuses without a tty when the database has tables', () => {
    const dir = project()
    const dump = path.join(dir, 'dump.sql')
    fs.writeFileSync(dump, 'SELECT 1;\n')
    const r = local(['db:import', dump], { cwd: dir, env: { LMA_TEST_DB_TABLES: '7' } })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /7 tables/)
    assert.ok(!dropRan(dir), 'an unconfirmed import must not drop the database')
})

test('import-db --dry-run reports the plan and imports nothing', () => {
    const dir = project()
    const dump = path.join(dir, 'dump.sql')
    fs.writeFileSync(dump, 'SELECT 1;\n')
    const r = local(['db:import', dump, '--dry-run'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '7' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\].*DROP DATABASE/)
    assert.match(r.out, /\[dry-run\] import .*dump\.sql/)
    assert.ok(!dropRan(dir))
})

test('import-db --yes runs the drop and the restore', () => {
    const dir = project()
    const dump = path.join(dir, 'dump.sql')
    fs.writeFileSync(dump, 'SELECT 1;\n')
    const r = local(['db:import', dump, '--yes'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '7' } })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(dropRan(dir))
})

test('an import that hits errors says so and keeps the log', () => {
    const dir = project()
    const dump = path.join(dir, 'dump.sql')
    fs.writeFileSync(dump, 'SELECT 1;\n')
    const r = local(['db:import', dump, '--yes'], {
        cwd: dir,
        env: { LMA_TEST_DB_TABLES: '7', LMA_TEST_IMPORT_ERRORS: '7' },
    })
    assert.notStrictEqual(r.status, 0, 'a partial restore must not report success')
    assert.match(r.out, /import completed with 7 error\(s\); the database may be incomplete/)
    assert.match(r.out, /\.\.\. and 2 more/, 'the first five, then a pointer to the log')
    const log = path.join(dir, '.local-medusa-app', 'last-import.log')
    assert.match(fs.readFileSync(log, 'utf8'), /ERROR:/, 'the log survives for diagnosis')
})

test('a clean import leaves no log behind', () => {
    const dir = project()
    const dump = path.join(dir, 'dump.sql')
    fs.writeFileSync(dump, 'SELECT 1;\n')
    local(['db:import', dump, '--yes'], { cwd: dir, env: { LMA_TEST_DB_TABLES: '7' } })
    assert.ok(!fs.existsSync(path.join(dir, '.local-medusa-app', 'last-import.log')))
})

test('stop keeps the volumes', () => {
    const dir = project()
    const r = local(['stop'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'down'))
    assert.ok(!ranDocker(dir, 'compose', 'down', '-v'), 'stop must never pass -v')
})

test('dump-db --dry-run writes no file', () => {
    const dir = project()
    const r = local(['db:dump', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.match(r.out, /\[dry-run\] pg_dump/)
    assert.ok(!fs.existsSync(path.join(dir, '.local-medusa-app', 'dumps')), 'no dump directory on a dry run')
})

const dropRan = (dir) =>
    dockerCalls(dir).some((argv) =>
        argv.includes('psql') && argv.some((a) => /DROP DATABASE/.test(a)))
