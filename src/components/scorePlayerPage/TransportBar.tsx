import { memo } from 'react'

function IconButton(props: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const { title, onClick, disabled, children } = props
  return (
    <button className="transport-icon-btn" type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

function PlayIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l12-7-12-7z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h3v14H7V5zm7 0h3v14h-3V5z" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h10v10H7V7z" fill="currentColor" />
    </svg>
  )
}

export const TransportBar = memo(function TransportBar(props: {
  isPlaying: boolean
  currentTime: number
  duration: number
  onPlayPause: () => void
  onStop: () => void
  onSeek: (t: number) => void
  disabled?: boolean
}) {
  const { isPlaying, currentTime, duration, onPlayPause, onStop, onSeek, disabled } = props

  return (
    <div className="transport-bar" aria-label="Transport controls">
      <div className="transport-bar__left">
        <IconButton title={isPlaying ? 'Pause' : 'Play'} onClick={onPlayPause} disabled={disabled}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton title="Stop" onClick={onStop} disabled={disabled}>
          <StopIcon />
        </IconButton>
      </div>

      <div className="transport-bar__middle">
        <div className="transport-bar__time">
          {currentTime.toFixed(1)}s / {duration.toFixed(1)}s
        </div>
        <input
          className="transport-bar__slider"
          type="range"
          min={0}
          max={duration}
          step={0.05}
          value={currentTime}
          onChange={e => onSeek(parseFloat(e.target.value))}
          disabled={disabled}
          aria-label="Seek"
        />
      </div>
    </div>
  )
})


