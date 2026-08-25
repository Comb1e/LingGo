import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {
  Activity,
  Brain,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Pause,
  Pencil,
  Play,
  Redo2,
  RotateCcw,
  Save,
  SkipForward,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import {useCallback, useEffect, useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useNavigate, useParams} from 'react-router-dom'
import {pointToCoordinate} from '../../shared/coordinates'
import {normalizeReasoning} from '../../shared/reasoning'
import type {Color, Game, GameAnalysis, Point} from '../../shared/types'
import {api} from '../api'
import {Board} from '../Board'
import {
  Button,
  ErrorBanner,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components'

export function GamePage() {
  const {id = ''} = useParams()
  const navigate = useNavigate()
  const {t} = useTranslation()
  const queryClient = useQueryClient()
  const [commandError, setCommandError] = useState<unknown>()
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState({
    blackName: '',
    whiteName: '',
    commentsVisible: true,
    moveCap: 1,
  })
  const gameQuery = useQuery({
    queryKey: ['game', id],
    queryFn: () => api.game(id),
    enabled: Boolean(id),
  })
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const analysisQuery = useQuery({
    queryKey: ['analysis', id],
    queryFn: () => api.analysis(id),
    enabled: Boolean(id),
  })
  const analysisMutation = useMutation({
    mutationFn: (input: {enabled?: boolean; shareWithLlm?: boolean}) =>
      api.setAnalysis(id, input),
    onMutate: (input) => {
      void queryClient.cancelQueries({queryKey: ['analysis', id]})
      const previous = queryClient.getQueryData<GameAnalysis>(['analysis', id])
      queryClient.setQueryData<GameAnalysis>(['analysis', id], (current) =>
        current
          ? {
              ...current,
              enabled: input.shareWithLlm
                ? true
                : (input.enabled ?? current.enabled),
              shareWithLlm:
                input.enabled === false
                  ? false
                  : (input.shareWithLlm ?? current.shareWithLlm),
            }
          : current,
      )
      return {previous}
    },
    onSuccess: (value) => queryClient.setQueryData(['analysis', id], value),
    onError: (_error, _input, context) =>
      queryClient.setQueryData(['analysis', id], context?.previous),
  })
  const backfillMutation = useMutation({
    mutationFn: () => api.backfillAnalysis(id),
    onSuccess: (value) => queryClient.setQueryData(['analysis', id], value),
  })
  const mutation = useMutation({
    mutationFn: (command: Record<string, unknown>) => api.command(id, command),
    onSuccess: (game) => {
      queryClient.setQueryData(['game', id], game)
      setCommandError(undefined)
    },
    onError: async (error) => {
      setCommandError(error)
      await queryClient.invalidateQueries({queryKey: ['game', id]})
    },
  })
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteGame(id),
    onSuccess: async () => {
      queryClient.removeQueries({queryKey: ['game', id]})
      await queryClient.invalidateQueries({queryKey: ['games']})
      navigate('/games')
    },
  })
  const editMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) => api.updateGame(id, input),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['game', id], updated)
      await queryClient.invalidateQueries({queryKey: ['games']})
      setEditing(false)
      setCommandError(undefined)
    },
    onError: async (error) => {
      setCommandError(error)
      await queryClient.invalidateQueries({queryKey: ['game', id]})
    },
  })
  const game = gameQuery.data

  useEffect(() => {
    if (!id) return
    const events = new EventSource(`/api/games/${id}/events`)
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as Game | null
      if (!next) {
        queryClient.removeQueries({queryKey: ['game', id]})
        navigate('/games')
        return
      }
      queryClient.setQueryData(['game', id], next)
      void queryClient.invalidateQueries({queryKey: ['games']})
    }
    return () => events.close()
  }, [id, navigate, queryClient])

  useEffect(() => {
    if (!id) return
    const events = new EventSource(`/api/games/${id}/analysis/events`)
    events.onmessage = (event) =>
      queryClient.setQueryData(
        ['analysis', id],
        JSON.parse(event.data) as GameAnalysis,
      )
    return () => events.close()
  }, [id, queryClient])

  const send = useCallback(
    (type: string, extra: Record<string, unknown> = {}) => {
      if (!game) return
      mutation.mutate({expectedVersion: game.version, type, ...extra})
    },
    [game, mutation],
  )

  const onPoint = useCallback(
    (point: Point) => {
      if (!game) return
      const coordinate = pointToCoordinate(point, game.size)
      if (game.status === 'scoring') send('toggle-dead', {coordinate})
      else if (
        game.status === 'active' &&
        (game.toMove === 'B' ? game.black : game.white).type === 'human'
      )
        send('play', {coordinate})
    },
    [game, send],
  )

  if (gameQuery.isLoading || !game)
    return (
      <div className="page">
        <Loading label={t('opening')} />
        <ErrorBanner error={gameQuery.error} />
      </div>
    )
  const current = game.toMove === 'B' ? game.black : game.white
  const usage = game.moves.reduce(
    (total, move) => ({
      calls: total.calls + (move.model ? 1 : 0),
      tokens: total.tokens + (move.inputTokens ?? 0) + (move.outputTokens ?? 0),
    }),
    {calls: 0, tokens: 0},
  )
  const humanTurn = game.status === 'active' && current.type === 'human'
  const startEditing = () => {
    setEditDraft({
      blackName: game.black.name,
      whiteName: game.white.name,
      commentsVisible: game.commentsVisible,
      moveCap: game.moveCap,
    })
    setCommandError(undefined)
    setEditing(true)
  }

  return (
    <div className="page game-page">
      <PageHeader
        title={`${game.black.name} · ${game.white.name}`}
        actions={
          <>
            <StatusBadge status={game.status} label={t(game.status)} />
            <a
              className="button icon-button"
              href={`/api/games/${game.id}/export.sgf`}
              title={t('exportSgf')}
            >
              <Download />
            </a>
            <Button
              className="icon-button"
              type="button"
              title={t('editGame')}
              aria-label={t('editGame')}
              onClick={startEditing}
            >
              <Pencil />
            </Button>
            <Button
              className="icon-button danger-quiet"
              type="button"
              title={t('delete')}
              aria-label={t('delete')}
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (window.confirm(t('deleteGameConfirm')))
                  deleteMutation.mutate()
              }}
            >
              <Trash2 />
            </Button>
          </>
        }
      />
      <ErrorBanner
        error={commandError ?? deleteMutation.error ?? gameQuery.error}
      />
      {editing && (
        <form
          className="game-edit-panel"
          onSubmit={(event) => {
            event.preventDefault()
            editMutation.mutate({
              expectedVersion: game.version,
              ...editDraft,
            })
          }}
        >
          <div className="game-edit-heading">
            <h2>{t('editGame')}</h2>
            <Button
              className="icon-button compact-icon"
              type="button"
              title={t('cancel')}
              aria-label={t('cancel')}
              onClick={() => setEditing(false)}
            >
              <X />
            </Button>
          </div>
          <div className="game-edit-fields">
            <label className="field">
              <span>{t('black')}</span>
              <input
                required
                maxLength={120}
                value={editDraft.blackName}
                onChange={(event) =>
                  setEditDraft({...editDraft, blackName: event.target.value})
                }
              />
            </label>
            <label className="field">
              <span>{t('white')}</span>
              <input
                required
                maxLength={120}
                value={editDraft.whiteName}
                onChange={(event) =>
                  setEditDraft({...editDraft, whiteName: event.target.value})
                }
              />
            </label>
            <label className="field">
              <span>{t('moveCap')}</span>
              <input
                required
                type="number"
                min={Math.max(1, game.moves.length)}
                value={editDraft.moveCap}
                onChange={(event) =>
                  setEditDraft({
                    ...editDraft,
                    moveCap: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="check-field game-edit-check">
              <input
                type="checkbox"
                checked={editDraft.commentsVisible}
                onChange={(event) =>
                  setEditDraft({
                    ...editDraft,
                    commentsVisible: event.target.checked,
                  })
                }
              />
              {t('commentary')}
            </label>
          </div>
          <div className="form-actions">
            <Button className="primary" disabled={editMutation.isPending}>
              <Save />
              {t('saveChanges')}
            </Button>
            <Button type="button" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      <div className="game-workspace">
        <section className="board-column">
          <div className="player-strip white-player">
            <i className="stone white-stone" />
            <span>
              <strong>{game.white.name}</strong>
              <small>
                {game.white.type === 'llm'
                  ? t('languageModel')
                  : game.white.type === 'katago'
                    ? 'KataGo'
                    : t('human')}
              </small>
            </span>
            <b>
              {game.captures.W} {t('captures')}
            </b>
          </div>
          <Board game={game} onPoint={onPoint} />
          <div className="player-strip black-player">
            <i className="stone black-stone" />
            <span>
              <strong>{game.black.name}</strong>
              <small>
                {game.black.type === 'llm'
                  ? t('languageModel')
                  : game.black.type === 'katago'
                    ? 'KataGo'
                    : t('human')}
              </small>
            </span>
            <b>
              {game.captures.B} {t('captures')}
            </b>
          </div>
          <WinRatePanel
            analysis={analysisQuery.data}
            moveCount={game.moves.length}
            busy={analysisMutation.isPending || backfillMutation.isPending}
            onToggle={(enabled) => analysisMutation.mutate(enabled)}
            onShare={(shareWithLlm) =>
              analysisMutation.mutate({shareWithLlm})
            }
            onAnalyze={() => backfillMutation.mutate()}
          />
        </section>
        <aside className="game-panel">
          <section className="turn-panel">
            {game.result ? (
              <>
                <span className="eyebrow">{t('result')}</span>
                <strong className="result-text">{game.result}</strong>
              </>
            ) : (
              <>
                <span className="eyebrow">
                  {game.pending
                    ? t('waiting')
                    : `${game.toMove === 'B' ? t('black') : t('white')} ${t('toMove')}`}
                </span>
                <strong>{current.name}</strong>
                {game.pending && (
                  <span className="thinking-line">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </>
            )}
          </section>
          {game.status === 'scoring' && (
            <ScoringPanel game={game} send={send} />
          )}
          {game.status === 'error' && (
            <RecoveryPanel
              game={game}
              profiles={profiles.data ?? []}
              send={send}
            />
          )}
          <div className="game-controls">
            {humanTurn && (
              <>
                <Button
                  onClick={() => send('pass')}
                  disabled={mutation.isPending}
                >
                  <SkipForward />
                  {t('pass')}
                </Button>
                <Button
                  className="danger-quiet"
                  onClick={() => send('resign')}
                  disabled={mutation.isPending}
                >
                  <XCircle />
                  {t('resign')}
                </Button>
              </>
            )}
            {game.status === 'active' && game.autoplay && (
              <Button onClick={() => send('pause')}>
                <Pause />
                {t('pause')}
              </Button>
            )}
            {game.status === 'paused' && (
              <Button className="primary" onClick={() => send('resume')}>
                <Play />
                {t('resume')}
              </Button>
            )}
            {['active', 'paused', 'error'].includes(game.status) &&
              game.moves.length > 0 && (
                <Button
                  className="icon-button"
                  onClick={() => send('undo')}
                  title={t('undo')}
                >
                  <RotateCcw />
                </Button>
              )}
          </div>
          <section className="usage-strip">
            <span>{t('usage')}</span>
            <strong>
              {usage.calls} {t('calls')} · {usage.tokens.toLocaleString()}{' '}
              {t('tokens')}
            </strong>
          </section>
          <section className="history-section">
            <header>
              <h2>{t('moveHistory')}</h2>
              <button
                className="plain-icon"
                title={
                  game.commentsVisible ? t('hiddenCommentary') : t('commentary')
                }
                onClick={() =>
                  send('set-comments', {visible: !game.commentsVisible})
                }
              >
                {game.commentsVisible ? <Eye /> : <EyeOff />}
              </button>
            </header>
            <div className="move-list">
              {game.moves.length ? (
                [...game.moves].reverse().map((move) => (
                  <div className="move-row" key={move.number}>
                    <span className="move-number">{move.number}</span>
                    <i
                      className={`stone ${move.color === 'B' ? 'black-stone' : 'white-stone'}`}
                    />
                    <strong>{move.coordinate ?? t(move.action)}</strong>
                    {game.commentsVisible && move.comment && (
                      <p>{move.comment}</p>
                    )}
                    {game.commentsVisible && move.reasoning && (
                      <MoveReasoning text={move.reasoning} />
                    )}
                  </div>
                ))
              ) : (
                <p className="muted">{t('noMoves')}</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

function WinRatePanel({
  analysis,
  moveCount,
  busy,
  onToggle,
  onShare,
  onAnalyze,
}: {
  analysis?: GameAnalysis
  moveCount: number
  busy: boolean
  onToggle: (input: {enabled: boolean}) => void
  onShare: (shareWithLlm: boolean) => void
  onAnalyze: () => void
}) {
  const {t} = useTranslation()
  const positions = analysis?.positions ?? []
  const width = 600
  const height = 180
  const inset = 22
  const maxTurn = Math.max(moveCount, 1)
  const point = (turn: number, rate: number): [number, number] => [
    inset + (turn / maxTurn) * (width - inset * 2),
    inset + (1 - rate) * (height - inset * 2),
  ]
  const blackPoints = positions.map((value) =>
    point(value.turn, value.blackWinRate),
  )
  const whitePoints = positions.map((value) =>
    point(value.turn, value.whiteWinRate),
  )
  return (
    <section className="winrate-panel">
      <header>
        <span><Activity /> <strong>{t('winRate')}</strong></span>
        <div>
          {positions.length < moveCount + 1 && (
            <Button disabled={busy} onClick={onAnalyze}>{t('analyze')}</Button>
          )}
          <label className="switch-field compact-switch">
            <input type="checkbox" checked={analysis?.enabled ?? false} onChange={(event) => onToggle({enabled: event.target.checked})} />
            <span className="switch" />
            <span>{t('live')}</span>
          </label>
          <label className="switch-field compact-switch">
            <input
              type="checkbox"
              checked={analysis?.shareWithLlm ?? false}
              disabled={!analysis?.enabled}
              onChange={(event) => onShare(event.target.checked)}
            />
            <span className="switch" />
            <span>{t('shareWithLlm')}</span>
          </label>
        </div>
      </header>
      {analysis?.error && <p className="analysis-error">{analysis.error}</p>}
      {positions.length ? (
        <>
          <svg className="winrate-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('winRateChart')}>
            <line x1={inset} y1={height / 2} x2={width - inset} y2={height / 2} className="chart-midline" />
            <path d={smoothCurve(blackPoints)} className="chart-line black-line" />
            <path d={smoothCurve(whitePoints)} className="chart-line white-line" />
            {positions.map((value) => (
              <g key={value.turn}>
                <circle cx={point(value.turn, value.blackWinRate)[0]} cy={point(value.turn, value.blackWinRate)[1]} r="3.5" className="chart-dot black-dot" tabIndex={0}>
                  <title>{`${t('turn')} ${value.turn}: ${t('black')} ${(value.blackWinRate * 100).toFixed(1)}%, ${t('white')} ${(value.whiteWinRate * 100).toFixed(1)}%, ${t('blackScoreLead')} ${value.blackScoreLead.toFixed(1)}`}</title>
                </circle>
                <circle cx={point(value.turn, value.whiteWinRate)[0]} cy={point(value.turn, value.whiteWinRate)[1]} r="3.5" className="chart-dot white-dot" tabIndex={0}>
                  <title>{`${t('turn')} ${value.turn}: ${t('white')} ${(value.whiteWinRate * 100).toFixed(1)}%, ${t('black')} ${(value.blackWinRate * 100).toFixed(1)}%, ${t('blackScoreLead')} ${value.blackScoreLead.toFixed(1)}`}</title>
                </circle>
              </g>
            ))}
          </svg>
          <div className="chart-legend"><span><i className="legend-black" />{t('black')}</span><span><i className="legend-white" />{t('white')}</span></div>
        </>
      ) : (
        <p className="muted analysis-empty">{analysis?.status === 'running' ? t('analyzing') : t('noAnalysis')}</p>
      )}
    </section>
  )
}

function smoothCurve(points: Array<[number, number]>) {
  if (!points.length) return ''
  return points.slice(1).reduce((path, [x, y], index) => {
    const [previousX, previousY] = points[index]
    const middleX = (previousX + x) / 2
    return `${path} C ${middleX} ${previousY}, ${middleX} ${y}, ${x} ${y}`
  }, `M ${points[0][0]} ${points[0][1]}`)
}

function MoveReasoning({text}: {text: string}) {
  const {t} = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="move-reasoning">
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Brain />
        <span>{t('modelReasoning')}</span>
        <ChevronDown className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && <p className="reasoning-text">{normalizeReasoning(text)}</p>}
    </div>
  )
}

function ScoringPanel({
  game,
  send,
}: {
  game: Game
  send: (type: string, extra?: Record<string, unknown>) => void
}) {
  const {t} = useTranslation()
  return (
    <section className="scoring-panel">
      <span className="eyebrow">{t('scoreReview')}</span>
      <p>{t('markDead')}</p>
      {game.score && (
        <div className="score-line">
          <span>
            <i className="stone black-stone" />
            {game.score.black}
          </span>
          <span>
            <i className="stone white-stone" />
            {game.score.white}
          </span>
          <strong>{game.score.result}</strong>
        </div>
      )}
      <div className="approval-grid">
        {game.black.type === 'human' && (
          <Button
            className={game.approvals.includes('B') ? 'approved' : ''}
            disabled={game.approvals.includes('B')}
            onClick={() => send('approve-score', {color: 'B'})}
          >
            {t('blackApproval')}
          </Button>
        )}
        {game.white.type === 'human' && (
          <Button
            className={game.approvals.includes('W') ? 'approved' : ''}
            disabled={game.approvals.includes('W')}
            onClick={() => send('approve-score', {color: 'W'})}
          >
            {t('whiteApproval')}
          </Button>
        )}
      </div>
      {game.operatorConfirmationRequired && (
        <Button className="primary wide" onClick={() => send('approve-score')}>
          {t('confirmScore')}
        </Button>
      )}
      <Button className="wide" onClick={() => send('resume-play')}>
        <Redo2 />
        {t('resumePlay')}
      </Button>
    </section>
  )
}

function RecoveryPanel({
  game,
  profiles,
  send,
}: {
  game: Game
  profiles: Array<{id: string; name: string}>
  send: (type: string, extra?: Record<string, unknown>) => void
}) {
  const {t} = useTranslation()
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '')
  const currentColor: Color = game.toMove
  return (
    <section className="recovery-panel">
      <p>{game.error}</p>
      <div className="recovery-actions">
        <Button className="primary" onClick={() => send('retry')}>
          <Play />
          {t('retry')}
        </Button>
        <Button onClick={() => send('force-pass')}>
          <SkipForward />
          {t('forcePass')}
        </Button>
        <Button onClick={() => send('resign')}>
          <XCircle />
          {t('resign')}
        </Button>
      </div>
      {profiles.length > 0 && (
        <div className="profile-switch">
          <select
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <Button
            onClick={() =>
              send('change-profile', {color: currentColor, profileId})
            }
          >
            {t('profile')}
          </Button>
        </div>
      )}
    </section>
  )
}
