import {afterEach, describe, expect, it} from 'vitest'
import {Store} from './database'

let store: Store | undefined
afterEach(() => store?.close())

describe('database migrations', () => {
  it('runs once and seeds a credential-free profile', () => {
    store = new Store(':memory:')
    expect(store.listConnections()).toHaveLength(1)
    expect(store.listProfiles()[0].connectionId).toBe('builtin-fake')
    const versions = store.db
      .prepare('SELECT version FROM schema_migrations')
      .all()
    expect(versions).toEqual([{version: 1}, {version: 2}, {version: 3}])
  })
})
