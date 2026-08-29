import {useQuery, useQueryClient} from '@tanstack/react-query'
import {BookOpen, Download, Pencil, Plus, Trash2} from 'lucide-react'
import {useEffect, useState} from 'react'
import {useTranslation} from 'react-i18next'
import {api} from './api'
import {Button, ErrorBanner, Loading} from './components'
import {Markdown} from './Markdown'

export function NotebookManager({
  profileId,
  selectedId,
  onSelect,
  label,
  disabledIds = [],
  autoSelect = true,
}: {
  profileId: string
  selectedId: string
  onSelect: (id: string) => void
  label?: string
  disabledIds?: string[]
  autoSelect?: boolean
}) {
  const {t} = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [preview, setPreview] = useState(false)
  const notebooks = useQuery({
    queryKey: ['notebooks', profileId],
    queryFn: () => api.notebooks(profileId),
    enabled: Boolean(profileId),
  })
  const selected = notebooks.data?.find(({id}) => id === selectedId)
  const content = useQuery({
    queryKey: ['notebook', profileId, selectedId],
    queryFn: () => api.notebook(profileId, selectedId),
    enabled: preview && Boolean(profileId && selectedId),
  })

  useEffect(() => {
    if (!autoSelect) return
    if (!notebooks.data) return
    if (
      !notebooks.data.some(
        ({id}) => id === selectedId && !disabledIds.includes(id),
      )
    )
      onSelect(
        notebooks.data.find(({id}) => !disabledIds.includes(id))?.id ?? '',
      )
  }, [autoSelect, disabledIds, notebooks.data, onSelect, selectedId])

  const refresh = () =>
    queryClient.invalidateQueries({queryKey: ['notebooks', profileId]})

  const create = async () => {
    const name = window.prompt(t('notebookCreatePrompt'))
    if (name === null) return
    setBusy(true)
    setError(undefined)
    try {
      const notebook = await api.createNotebook(profileId, name)
      await refresh()
      onSelect(notebook.id)
    } catch (nextError) {
      setError(nextError)
    } finally {
      setBusy(false)
    }
  }

  const rename = async () => {
    if (!selected) return
    const name = window.prompt(t('notebookRenamePrompt'), selected.name)
    if (name === null) return
    setBusy(true)
    setError(undefined)
    try {
      await api.renameNotebook(profileId, selected.id, name)
      await refresh()
    } catch (nextError) {
      setError(nextError)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (
      !selected ||
      !window.confirm(t('deleteNotebookConfirm', {name: selected.name}))
    )
      return
    setBusy(true)
    setError(undefined)
    try {
      await api.deleteNotebook(profileId, selected.id)
      setPreview(false)
      onSelect('')
      await refresh()
    } catch (nextError) {
      setError(nextError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="notebook-manager">
      <div className="notebook-toolbar">
        <label className="field">
          <span>{label ?? t('techniqueNotebook')}</span>
          <select
            value={selectedId}
            onChange={(event) => onSelect(event.target.value)}
            disabled={busy || notebooks.isLoading}
          >
            {!notebooks.data?.length && (
              <option value="">{t('noNotebooks')}</option>
            )}
            {notebooks.data?.map((notebook) => (
              <option
                key={notebook.id}
                value={notebook.id}
                disabled={disabledIds.includes(notebook.id)}
              >
                {notebook.name}
              </option>
            ))}
          </select>
        </label>
        <div className="notebook-actions">
          <Button
            type="button"
            className="icon-button"
            title={t('createNotebook')}
            aria-label={t('createNotebook')}
            disabled={busy || !profileId}
            onClick={() => void create()}
          >
            <Plus />
          </Button>
          <Button
            type="button"
            className="icon-button"
            title={t('renameNotebook')}
            aria-label={t('renameNotebook')}
            disabled={busy || !selected}
            onClick={() => void rename()}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            className="icon-button"
            title={t('previewNotebook')}
            aria-label={t('previewNotebook')}
            disabled={!selected}
            onClick={() => setPreview((value) => !value)}
          >
            <BookOpen />
          </Button>
          <a
            className={`button icon-button${selected ? '' : ' disabled'}`}
            href={
              selected
                ? `/api/profiles/${profileId}/notebooks/${selected.id}.md`
                : undefined
            }
            download
            title={t('downloadNotebook')}
            aria-label={t('downloadNotebook')}
          >
            <Download />
          </a>
          <Button
            type="button"
            className="icon-button danger-quiet"
            title={t('deleteNotebook')}
            aria-label={t('deleteNotebook')}
            disabled={busy || !selected}
            onClick={() => void remove()}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <ErrorBanner error={error ?? notebooks.error ?? content.error} />
      {preview && selected && (
        <div className="notebook-preview">
          {content.isLoading ? (
            <Loading />
          ) : content.data ? (
            <Markdown source={content.data} />
          ) : (
            <p className="muted">{t('emptyNotebook')}</p>
          )}
        </div>
      )}
    </div>
  )
}
