import {useQuery, useQueryClient} from '@tanstack/react-query'
import {Download, FileUp, Plus, Trash2} from 'lucide-react'
import {useRef, useState} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate} from 'react-router-dom'
import {api} from '../api'
import {
  Button,
  ErrorBanner,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components'

export function GamesPage() {
  const {t, i18n} = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<unknown>()
  const [warnings, setWarnings] = useState<string[]>([])
  const [deletingId, setDeletingId] = useState('')
  const [deleteError, setDeleteError] = useState<unknown>()
  const games = useQuery({queryKey: ['games'], queryFn: api.games})

  const importFile = async (file?: File) => {
    if (!file) return
    setImportError(undefined)
    try {
      const result = await api.importSgf(await file.text())
      setWarnings(result.warnings)
      if (!result.warnings.length) navigate(`/games/${result.game.id}`)
      else setTimeout(() => navigate(`/games/${result.game.id}`), 1800)
    } catch (error) {
      setImportError(error)
    }
  }

  const deleteGame = async (id: string) => {
    if (!window.confirm(t('deleteGameConfirm'))) return
    setDeletingId(id)
    setDeleteError(undefined)
    try {
      await api.deleteGame(id)
      await queryClient.invalidateQueries({queryKey: ['games']})
    } catch (error) {
      setDeleteError(error)
    } finally {
      setDeletingId('')
    }
  }

  return (
    <div className="page games-page">
      <PageHeader
        title={t('recentGames')}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".sgf,application/x-go-sgf"
              hidden
              onChange={(event) => void importFile(event.target.files?.[0])}
            />
            <Button onClick={() => fileInput.current?.click()}>
              <FileUp />
              {t('importSgf')}
            </Button>
            <Link className="button primary" to="/new">
              <Plus />
              {t('newGame')}
            </Link>
          </>
        }
      />
      <ErrorBanner error={importError ?? deleteError ?? games.error} />
      {warnings.length > 0 && (
        <div className="banner warning-banner">{warnings.join(' ')}</div>
      )}
      {games.isLoading ? (
        <Loading />
      ) : games.data?.length ? (
        <div className="game-list">
          {games.data.map((game) => (
            <div className="game-row" key={game.id}>
              <Link to={`/games/${game.id}`} className="game-row-main">
                <div className="game-players">
                  <strong>
                    <i className="stone black-stone" />
                    {game.black.name}
                  </strong>
                  <span>vs</span>
                  <strong>
                    <i className="stone white-stone" />
                    {game.white.name}
                  </strong>
                </div>
                <div className="game-meta">
                  <span>
                    {game.size}×{game.size}
                  </span>
                  <span>{game.moves.length} moves</span>
                  <span>
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(game.updatedAt))}
                  </span>
                </div>
                <div className="game-result">
                  {game.result ?? (
                    <StatusBadge status={game.status} label={t(game.status)} />
                  )}
                  <Download className="row-arrow" />
                </div>
              </Link>
              <Button
                className="icon-button danger-quiet row-delete"
                type="button"
                title={t('delete')}
                aria-label={`${t('delete')} ${game.black.name} vs ${game.white.name}`}
                disabled={deletingId === game.id}
                onClick={() => void deleteGame(game.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-board" aria-hidden="true" />
          <h2>{t('noGames')}</h2>
          <Link className="button primary" to="/new">
            <Plus />
            {t('newGame')}
          </Link>
        </div>
      )}
    </div>
  )
}
