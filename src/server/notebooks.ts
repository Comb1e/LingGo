import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {
  BenchmarkRun,
  TechniqueNotebook,
  TechniqueNotebookSummary,
} from '../shared/types'
import {Store} from './database'

export class NotebookStore {
  readonly store?: Store
  readonly root?: string

  constructor(storeOrRoot: Store | string = new Store()) {
    if (storeOrRoot instanceof Store) this.store = storeOrRoot
    else this.root = storeOrRoot
  }

  list(profileId: string): TechniqueNotebookSummary[] {
    return this.store?.listNotebooks(profileId) ?? []
  }

  get(profileId: string, notebookId: string): TechniqueNotebook | undefined {
    return this.store?.getNotebook(profileId, notebookId)
  }

  create(profileId: string, name: string) {
    if (!this.store) throw new Error('Named notebooks require SQLite storage')
    return this.store.createNotebook(profileId, name)
  }

  rename(profileId: string, notebookId: string, name: string) {
    if (!this.store) throw new Error('Named notebooks require SQLite storage')
    return this.store.renameNotebook(profileId, notebookId, name)
  }

  delete(profileId: string, notebookId: string) {
    if (!this.store) throw new Error('Named notebooks require SQLite storage')
    return this.store.deleteNotebook(profileId, notebookId)
  }

  async readCurrent(profileId: string, notebookId?: string) {
    if (this.store)
      return notebookId
        ? (this.store.getNotebook(profileId, notebookId)?.content ?? '')
        : ''
    return this.read(this.currentPath(profileId))
  }

  async readSnapshot(runId: string) {
    if (this.store) return this.store.getNotebookSnapshot(runId)?.content ?? ''
    return this.read(this.snapshotPath(runId))
  }

  async saveReflection(
    notebook: TechniqueNotebook,
    run: BenchmarkRun,
    markdown: string,
  ) {
    if (this.store) {
      this.store.saveReflection(notebook, run, markdown)
      return
    }
    await this.write(notebook.profileId, run.id, markdown)
  }

  async write(profileId: string, runId: string, markdown: string) {
    if (this.store) throw new Error('Use saveReflection for named notebooks')
    await mkdir(join(this.root!, 'runs'), {recursive: true})
    await Promise.all([
      this.atomicWrite(this.currentPath(profileId), markdown),
      this.atomicWrite(this.snapshotPath(runId), markdown),
    ])
  }

  async deleteCurrent(profileId: string) {
    if (this.store) return
    await unlink(this.currentPath(profileId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
  }

  async deleteSnapshot(runId: string) {
    if (this.store) return
    await unlink(this.snapshotPath(runId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
  }

  async writeRunSnapshot(runId: string, markdown: string) {
    if (this.store) return
    await mkdir(join(this.root!, 'runs'), {recursive: true})
    await this.atomicWrite(this.snapshotPath(runId), markdown)
  }

  private currentPath(id: string) {
    return join(this.root!, `${safeId(id)}.md`)
  }

  private snapshotPath(id: string) {
    return join(this.root!, 'runs', `${safeId(id)}.md`)
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
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error('Invalid notebook identifier')
  return id
}
