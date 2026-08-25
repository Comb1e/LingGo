import {useQuery} from '@tanstack/react-query'
import {Bot, Check, CircleUserRound, Play, Settings} from 'lucide-react'
import {useState, type FormEvent} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate} from 'react-router-dom'
import type {
  BoardSize,
  PlayerProfile,
  ProviderConnection,
} from '../../shared/types'
import {api} from '../api'
import {Button, ErrorBanner, PageHeader} from '../components'

type SeatForm = {type: 'human' | 'llm'; name: string; profileId: string}

export function NewGamePage() {
  const {t} = useTranslation()
  const navigate = useNavigate()
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
  })
  const [size, setSize] = useState<BoardSize>(19)
  const [komi, setKomi] = useState(7.5)
  const [black, setBlack] = useState<SeatForm>({
    type: 'human',
    name: t('black'),
    profileId: 'builtin-fake-profile',
  })
  const [white, setWhite] = useState<SeatForm>({
    type: 'llm',
    name: 'Local learner',
    profileId: 'builtin-fake-profile',
  })
  const [commentsVisible, setCommentsVisible] = useState(true)
  const [analysisEnabled, setAnalysisEnabled] = useState(true)
  const [shareAnalysisWithLlm, setShareAnalysisWithLlm] = useState(false)
  const [moveCap, setMoveCap] = useState(19 * 19 * 2)
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  const changeSize = (next: BoardSize) => {
    setSize(next)
    setMoveCap(next * next * 2)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const toSeat = (seat: SeatForm) =>
        seat.type === 'human'
          ? {type: 'human' as const, name: seat.name || t('human')}
          : {
              type: 'llm' as const,
              name:
                profiles.data?.find((p) => p.id === seat.profileId)?.name ??
                'Model',
              profileId: seat.profileId,
            }
      const game = await api.createGame({
        size,
        komi,
        black: toSeat(black),
        white: toSeat(white),
        commentsVisible,
        moveCap,
        analysisEnabled,
        shareAnalysisWithLlm,
      })
      navigate(`/games/${game.id}`)
    } catch (caught) {
      setError(caught)
      setBusy(false)
    }
  }

  return (
    <div className="page form-page">
      <PageHeader title={t('newGame')} />
      <ErrorBanner error={error ?? profiles.error ?? connections.error} />
      <form onSubmit={(event) => void submit(event)}>
        <section className="form-section">
          <div className="field-group">
            <label>{t('boardSize')}</label>
            <div className="segmented" role="radiogroup">
              {([9, 13, 19] as BoardSize[]).map((value) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={size === value}
                  className={size === value ? 'selected' : ''}
                  key={value}
                  onClick={() => changeSize(value)}
                >
                  {value}×{value}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{t('komi')}</span>
            <input
              type="number"
              step="0.5"
              value={komi}
              onChange={(event) => setKomi(Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>{t('moveCap')}</span>
            <input
              type="number"
              min="1"
              value={moveCap}
              onChange={(event) => setMoveCap(Number(event.target.value))}
            />
          </label>
        </section>
        <section className="seat-grid">
          <SeatEditor
            color="black"
            label={t('black')}
            value={black}
            onChange={setBlack}
            profiles={profiles.data ?? []}
            connections={connections.data ?? []}
          />
          <SeatEditor
            color="white"
            label={t('white')}
            value={white}
            onChange={setWhite}
            profiles={profiles.data ?? []}
            connections={connections.data ?? []}
          />
        </section>
        <section className="form-section options-row">
          <label className="switch-field">
            <input
              type="checkbox"
              checked={commentsVisible}
              onChange={(event) => setCommentsVisible(event.target.checked)}
            />
            <span className="switch" />
            <span>{t('commentary')}</span>
          </label>
          <label className="switch-field">
            <input
              type="checkbox"
              checked={analysisEnabled}
              onChange={(event) => {
                setAnalysisEnabled(event.target.checked)
                if (!event.target.checked) setShareAnalysisWithLlm(false)
              }}
            />
            <span className="switch" />
            <span>{t('liveAnalysis')}</span>
          </label>
          <label className="switch-field">
            <input
              type="checkbox"
              checked={shareAnalysisWithLlm}
              disabled={!analysisEnabled}
              onChange={(event) =>
                setShareAnalysisWithLlm(event.target.checked)
              }
            />
            <span className="switch" />
            <span>{t('shareAnalysisWithLlm')}</span>
          </label>
          <Button className="primary submit-button" disabled={busy}>
            <Play />
            {t('createGame')}
          </Button>
        </section>
      </form>
    </div>
  )
}

function SeatEditor({
  color,
  label,
  value,
  onChange,
  profiles,
  connections,
}: {
  color: 'black' | 'white'
  label: string
  value: SeatForm
  onChange: (value: SeatForm) => void
  profiles: PlayerProfile[]
  connections: ProviderConnection[]
}) {
  const {t} = useTranslation()
  const connectionNames = new Map(
    connections.map((connection) => [connection.id, connection.name]),
  )
  return (
    <section className={`seat-editor ${color}`}>
      <header>
        <i className={`stone ${color}-stone`} />
        <h2>{label}</h2>
      </header>
      <div className="segmented seat-type">
        <button
          type="button"
          className={value.type === 'human' ? 'selected' : ''}
          onClick={() => onChange({...value, type: 'human'})}
        >
          <CircleUserRound />
          {t('human')}
        </button>
        <button
          type="button"
          className={value.type === 'llm' ? 'selected' : ''}
          onClick={() => onChange({...value, type: 'llm'})}
        >
          <Bot />
          {t('languageModel')}
        </button>
      </div>
      {value.type === 'human' ? (
        <label className="field">
          <span>{t('profileName')}</span>
          <input
            value={value.name}
            onChange={(event) => onChange({...value, name: event.target.value})}
          />
        </label>
      ) : (
        <div className="llm-picker">
          <div className="llm-picker-heading">
            <span>{t('savedLlms')}</span>
            <Link to="/settings" className="manage-llms">
              <Settings />
              {t('manageLlms')}
            </Link>
          </div>
          <div className="llm-option-list" role="radiogroup">
            {profiles.map((profile) => (
              <button
                type="button"
                role="radio"
                aria-checked={value.profileId === profile.id}
                className={`llm-option ${
                  value.profileId === profile.id ? 'selected' : ''
                }`}
                key={profile.id}
                onClick={() => onChange({...value, profileId: profile.id})}
              >
                <span className="llm-option-copy">
                  <strong>{profile.modelId}</strong>
                  <small>
                    {profile.name} ·{' '}
                    {connectionNames.get(profile.connectionId) ?? t('unknown')}
                  </small>
                </span>
                {value.profileId === profile.id && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
