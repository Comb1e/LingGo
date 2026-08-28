import {useQuery} from '@tanstack/react-query'
import {
  ArrowRight,
  CheckCircle2,
  CircleX,
  Eye,
  RotateCcw,
  Shuffle,
} from 'lucide-react'
import {useState} from 'react'
import {useTranslation} from 'react-i18next'
import {coordinateToPoint, pointToCoordinate} from '../../shared/coordinates'
import type {
  BenchmarkProblemView,
  Game,
  LifeDeathAnswerResult,
  LifeDeathProblemSetView,
  PlayerAction,
  Point,
} from '../../shared/types'
import {api} from '../api'
import {Board} from '../Board'
import {Button, ErrorBanner, Loading, PageHeader} from '../components'
import {shuffledProblemIds} from '../lifeDeath'

type ProblemSetSummary = {
  id: string
  version: string
  checksum: string
  count: number
  source?: string
  license?: string
  attribution?: string
}

export function LifeDeathPage() {
  const {t} = useTranslation()
  const sets = useQuery({
    queryKey: ['life-death-problem-sets'],
    queryFn: api.lifeDeathProblemSets,
  })
  const [chosenSetId, setChosenSetId] = useState('')
  const selectedSetId = chosenSetId || sets.data?.[0]?.id || ''
  const problemSet = useQuery({
    queryKey: ['life-death-problem-set', selectedSetId],
    queryFn: () => api.lifeDeathProblemSet(selectedSetId),
    enabled: Boolean(selectedSetId),
  })
  const [runNumber, setRunNumber] = useState(0)
  const restart = () => setRunNumber((current) => current + 1)

  return (
    <div className="page life-death-page">
      <PageHeader
        title={t('lifeDeathPractice')}
        actions={
          <Button onClick={restart} disabled={!problemSet.data?.count}>
            <Shuffle />
            {t('newRandomRun')}
          </Button>
        }
      />
      <ErrorBanner error={sets.error ?? problemSet.error} />
      {sets.isLoading || (selectedSetId && problemSet.isLoading) ? (
        <Loading />
      ) : !sets.data?.length ? (
        <div className="empty-state">
          <h2>{t('noLifeDeathProblems')}</h2>
        </div>
      ) : (
        problemSet.data && (
          <LifeDeathRun
            key={`${selectedSetId}:${problemSet.data.checksum}:${runNumber}`}
            problemSet={problemSet.data}
            availableSets={sets.data}
            selectedSetId={selectedSetId}
            onSelectSet={setChosenSetId}
            onRestart={restart}
          />
        )
      )}
    </div>
  )
}

function LifeDeathRun({
  problemSet,
  availableSets,
  selectedSetId,
  onSelectSet,
  onRestart,
}: {
  problemSet: LifeDeathProblemSetView
  availableSets: ProblemSetSummary[]
  selectedSetId: string
  onSelectSet: (id: string) => void
  onRestart: () => void
}) {
  const {t} = useTranslation()
  const [order] = useState(() => shuffledProblemIds(problemSet.problems))
  const [cursor, setCursor] = useState(0)
  const [attempts, setAttempts] = useState<LifeDeathAnswerResult[]>([])
  const [result, setResult] = useState<LifeDeathAnswerResult>()
  const [progress, setProgress] = useState<LifeDeathAnswerResult>()
  const [sequence, setSequence] = useState<PlayerAction[]>([])
  const [showAnswer, setShowAnswer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const problem = problemSet.problems.find(({id}) => id === order[cursor])
  const completed = order.length > 0 && cursor >= order.length
  const correctCount = attempts.filter(({correct}) => correct).length

  const answer = async (action: PlayerAction) => {
    if (!problem || result || busy) return
    setBusy(true)
    setError(undefined)
    setShowAnswer(false)
    try {
      const judged = await api.answerLifeDeathProblem(
        selectedSetId,
        problem.id,
        action,
        [...sequence, action],
      )
      setSequence((current) => [...current, action])
      if (judged.complete || !judged.correct) {
        setResult(judged)
        setAttempts((current) => [...current, judged])
      } else {
        setProgress(judged)
      }
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const answerPoint = (point: Point) => {
    if (!problem) return
    void answer({
      action: 'play',
      coordinate: pointToCoordinate(point, problem.size),
      comment: '',
    })
  }

  const next = () => {
    setResult(undefined)
    setProgress(undefined)
    setSequence([])
    setShowAnswer(false)
    setError(undefined)
    setCursor((current) => current + 1)
  }

  const redo = () => {
    setResult(undefined)
    setProgress(undefined)
    setSequence([])
    setShowAnswer(false)
    setError(undefined)
  }

  return (
    <>
      <ErrorBanner error={error} />
      <section className="life-death-toolbar">
        <label className="field">
          <span>{t('lifeDeathProblemSet')}</span>
          <select
            value={selectedSetId}
            onChange={(event) => onSelectSet(event.target.value)}
          >
            {availableSets.map((set) => (
              <option value={set.id} key={set.id}>
                {set.id} · v{set.version} · {set.count} {t('problems')}
              </option>
            ))}
          </select>
          {problemSet.source && (
            <small className="life-death-provenance">
              {t('source')}:{' '}
              <a href={problemSet.source} target="_blank" rel="noreferrer">
                {problemSet.attribution ?? problemSet.source}
              </a>
              {problemSet.license ? ` · ${problemSet.license}` : ''}
            </small>
          )}
        </label>
        <div className="life-death-run-metrics">
          <Metric label={t('answered')} value={`${attempts.length}`} />
          <Metric label={t('correct')} value={`${correctCount}`} />
          <Metric
            label={t('failed')}
            value={`${attempts.length - correctCount}`}
          />
        </div>
      </section>

      {completed ? (
        <section className="life-death-complete">
          <CheckCircle2 />
          <h2>{t('runComplete')}</h2>
          <strong>
            {correctCount} / {order.length}
          </strong>
          <Button className="primary" onClick={onRestart}>
            <RotateCcw />
            {t('startAnotherRun')}
          </Button>
        </section>
      ) : problem ? (
        <section className="life-death-workspace">
          <div className="life-death-board-column">
            <header>
              <div>
                <span>
                  {t('problemNumber', {
                    current: cursor + 1,
                    total: order.length,
                  })}
                </span>
                <h2>{problem.title ?? problem.id}</h2>
              </div>
              <strong>
                {problem.sideToMove === 'B' ? t('black') : t('white')}{' '}
                {t('toMove')}
              </strong>
            </header>
            <Board
              game={problemAsGame(problem, result ?? progress)}
              onPoint={answerPoint}
              disabled={Boolean(result)}
              busy={busy}
            />
          </div>
          <aside className="game-panel life-death-panel">
            <div className="life-death-actions">
              <Button
                onClick={() => void answer({action: 'pass', comment: ''})}
                disabled={Boolean(result) || busy}
              >
                {t('pass')}
              </Button>
              <Button
                onClick={() => void answer({action: 'resign', comment: ''})}
                disabled={Boolean(result) || busy}
              >
                {t('resign')}
              </Button>
            </div>
            {result && (
              <div
                className={`life-death-result ${result.correct ? 'correct' : 'failed'}`}
                role="status"
              >
                {result.correct ? <CheckCircle2 /> : <CircleX />}
                <div>
                  <strong>
                    {result.correct
                      ? t('correctAnswer')
                      : result.legal
                        ? t('wrongAnswer')
                        : t('illegalAnswer')}
                  </strong>
                  <span>
                    {result.correct || showAnswer
                      ? `${t('expectedAnswer')}: ${actionLabel(result.expectedAction, t)}`
                      : t('answerHidden')}
                  </span>
                </div>
              </div>
            )}
            {result && !result.correct ? (
              <div className="life-death-failure-actions">
                <Button onClick={redo}>
                  <RotateCcw />
                  {t('redoProblem')}
                </Button>
                <Button
                  onClick={() => setShowAnswer(true)}
                  disabled={showAnswer}
                >
                  <Eye />
                  {t('seeAnswer')}
                </Button>
                <Button className="primary" onClick={next}>
                  {t('nextProblem')}
                  <ArrowRight />
                </Button>
              </div>
            ) : result ? (
              <Button className="primary wide" onClick={next}>
                {cursor + 1 === order.length
                  ? t('viewResults')
                  : t('nextProblem')}
                <ArrowRight />
              </Button>
            ) : null}
            {progress && !result && (
              <div className="life-death-result correct" role="status">
                <CheckCircle2 />
                <div>
                  <strong>{t('correctStep')}</strong>
                  {progress.nextExpectedAction && (
                    <span>{t('continueProblem')}</span>
                  )}
                </div>
              </div>
            )}
            <div className="life-death-history">
              <h3>{t('attemptHistory')}</h3>
              {attempts.length ? (
                attempts.toReversed().map((attempt, index) => (
                  <div key={`${attempt.problemId}-${attempts.length - index}`}>
                    {attempt.correct ? <CheckCircle2 /> : <CircleX />}
                    <span>{attempt.problemId}</span>
                    <strong>{actionLabel(attempt.action, t)}</strong>
                  </div>
                ))
              ) : (
                <p>{t('noAttemptsYet')}</p>
              )}
            </div>
          </aside>
        </section>
      ) : null}
    </>
  )
}

function problemAsGame(
  problem: BenchmarkProblemView,
  answer?: LifeDeathAnswerResult,
): Game {
  const now = new Date(0).toISOString()
  const answeredMove =
    answer?.legal && answer.action
      ? {
          number: problem.moves.length + 1,
          color: problem.sideToMove,
          action: answer.action.action,
          coordinate:
            answer.action.action === 'play'
              ? answer.action.coordinate
              : undefined,
          point:
            answer.action.action === 'play'
              ? coordinateToPoint(answer.action.coordinate, problem.size)
              : undefined,
          comment: answer.action.comment,
          captured: 0,
        }
      : undefined
  return {
    id: `life-death-${problem.id}`,
    version: 0,
    size: problem.size,
    komi: problem.komi,
    board: answer?.board ?? problem.board,
    toMove: problem.sideToMove,
    status: 'active',
    black: {type: 'human', name: 'Black'},
    white: {type: 'human', name: 'White'},
    moves: answeredMove ? [...problem.moves, answeredMove] : problem.moves,
    captures: problem.captures,
    commentsVisible: false,
    autoplay: false,
    moveCap: 722,
    dead: [],
    approvals: [],
    createdAt: now,
    updatedAt: now,
  }
}

function actionLabel(action: PlayerAction, t: (key: string) => string): string {
  return action.action === 'play' ? action.coordinate : t(action.action)
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
