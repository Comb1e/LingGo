import {useTranslation} from 'react-i18next'
import type {BenchmarkNotebookVersion} from '../shared/types'
import {Loading} from './components'
import {notebookNoteChanges} from './notebookChanges'

export function NotebookChanges({
  seed,
  versions,
  loading,
}: {
  seed: string
  versions: BenchmarkNotebookVersion[]
  loading: boolean
}) {
  const {t, i18n} = useTranslation()
  const changes = notebookNoteChanges(seed, versions)
  return (
    <section className="notebook-changes">
      <header>
        <h2>{t('notebookChanges')}</h2>
        {changes.length > 0 && <span>{changes.length}</span>}
      </header>
      {loading ? (
        <Loading />
      ) : changes.length ? (
        <div className="notebook-change-list">
          {changes.map((change) => (
            <article key={`${change.version}-${change.createdAt}`}>
              <header>
                <strong>
                  {t('notebookVersionLabel', {version: change.version})}
                </strong>
                <time dateTime={change.createdAt}>
                  {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(change.createdAt))}
                </time>
              </header>
              {change.notes.map((note) => (
                <div className="notebook-note-change" key={note.number}>
                  <strong>{t('notebookNote', note)}</strong>
                  <div className="notebook-note-before">
                    <span>{t('before')}</span>
                    <p>{note.before ?? t('notPresent')}</p>
                  </div>
                  <div className="notebook-note-after">
                    <span>{t('after')}</span>
                    <p>{note.after ?? t('removed')}</p>
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-state">{t('noNotebookChanges')}</p>
      )}
    </section>
  )
}
