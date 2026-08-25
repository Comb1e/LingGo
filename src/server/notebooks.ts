import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export class NotebookStore {
  constructor(readonly root = process.env.LINGGO_TECHNIQUES_DIR ?? join(process.cwd(), 'data', 'techniques')) {}

  async readCurrent(profileId: string) {
    return this.read(this.currentPath(profileId))
  }

  async readSnapshot(runId: string) {
    return this.read(this.snapshotPath(runId))
  }

  async write(profileId: string, runId: string, markdown: string) {
    await mkdir(join(this.root, 'runs'), {recursive: true})
    await Promise.all([
      this.atomicWrite(this.currentPath(profileId), markdown),
      this.atomicWrite(this.snapshotPath(runId), markdown),
    ])
  }

  async deleteCurrent(profileId: string) {
    await unlink(this.currentPath(profileId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  async deleteSnapshot(runId: string) {
    await unlink(this.snapshotPath(runId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  private currentPath(id: string) {
    return join(this.root, `${safeId(id)}.md`)
  }

  private snapshotPath(id: string) {
    return join(this.root, 'runs', `${safeId(id)}.md`)
  }

  private async atomicWrite(path: string, contents: string) {
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, contents, {encoding: 'utf8', mode: 0o600})
    await rename(temporary, path)
  }

  private async read(path: string) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
}

function safeId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid notebook identifier')
  return id
}
