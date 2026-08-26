// mutating commands take a lock; read-only ones must not
const test = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { project, cleanup, local, ranDocker, started } = require('./support/harness.js')

test.after(cleanup)

const lockDir = (dir) => path.join(dir, '.local-medusa-app', 'lock')

const holdLock = (dir, pid, cmd = 'start', id = started(pid)) => {
    fs.mkdirSync(lockDir(dir), { recursive: true })
    fs.writeFileSync(path.join(lockDir(dir), 'pid'), `${pid}\n`)
    fs.writeFileSync(path.join(lockDir(dir), 'cmd'), `${cmd}\n`)
    fs.writeFileSync(path.join(lockDir(dir), 'id'), id)
}

const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid

test('a mutating command refuses while another one holds the lock', () => {
    const dir = project()
    holdLock(dir, process.pid, 'start')
    const r = local(['stop'], { cwd: dir })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.out, /'lma start' \(pid \d+\) is already working on this project/)
    assert.ok(!ranDocker(dir, 'compose', 'down'), 'the blocked command must do nothing')
})

test('a lock whose pid has been reused is broken, not waited on forever', () => {
    const dir = project()
    holdLock(dir, process.pid, 'start', 'Wed Jan  1 00:00:00 2020\n')
    const r = local(['stop'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'down'), 'a live pid alone must not hold the project hostage')
})

test('a lock left behind by a dead process is taken over', () => {
    const dir = project()
    holdLock(dir, deadPid(), 'destroy')
    const r = local(['stop'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(ranDocker(dir, 'compose', 'down'))
})

test('the lock is released when the command finishes', () => {
    const dir = project()
    assert.strictEqual(local(['stop'], { cwd: dir }).status, 0)
    assert.ok(!fs.existsSync(lockDir(dir)), 'no lock may survive a clean exit')
    assert.strictEqual(local(['stop'], { cwd: dir }).status, 0)
})

test('a dry run neither takes nor trips over the lock', () => {
    const dir = project()
    holdLock(dir, process.pid, 'start')
    const r = local(['destroy', '--dry-run'], { cwd: dir })
    assert.strictEqual(r.status, 0, r.out)
    assert.ok(fs.existsSync(lockDir(dir)), 'the holder keeps its lock')
})

test('read-only commands are not blocked by the lock', () => {
    const dir = project()
    holdLock(dir, process.pid, 'start')
    assert.strictEqual(local(['status'], { cwd: dir }).status, 0)
    assert.strictEqual(local(['show-env'], { cwd: dir }).status, 0)
    assert.strictEqual(local(['admin'], { cwd: dir }).status, 0)
})
