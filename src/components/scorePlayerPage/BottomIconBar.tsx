import { memo } from 'react'

function IconButton(props: {
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  const { title, onClick, disabled, active, children } = props
  return (
    <button
      className={`transport-icon-btn${active ? ' is-active' : ''}`}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
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

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
        fill="currentColor"
      />
    </svg>
  )
}

function VolumeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zm0-10v2.06A9 9 0 0 1 21 12a9 9 0 0 1-4.5 7.94V22A11 11 0 0 0 23 12 11 11 0 0 0 16.5 2z"
        fill="currentColor"
      />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.22-1.12.52-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.41 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.22 1.12-.52 1.63-.94l2.39.96c.22.09.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"
        fill="currentColor"
      />
    </svg>
  )
}

export const BottomIconBar = memo(function BottomIconBar(props: {
  disabled?: boolean
  isPlaying: boolean
  micActive: boolean
  currentTime: number
  duration: number
  onSeek: (t: number) => void
  onPlayPause: () => void
  onStop: () => void
  onMicClick: () => void
  onVolumeClick: () => void
  onSettingsClick: () => void
  activePanel: 'none' | 'voice' | 'mixer' | 'settings'
}) {
  const { disabled, isPlaying, micActive, currentTime, duration, onSeek, onPlayPause, onStop, onMicClick, onVolumeClick, onSettingsClick, activePanel } =
    props
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0

  return (
    <div className="bottom-icon-bar" aria-label="Playback and practice controls">
      <div className="bottom-icon-bar__left" aria-label="Main controls">
        <IconButton title={isPlaying ? 'Pause' : 'Play'} onClick={onPlayPause} disabled={disabled}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton title="Stop" onClick={onStop} disabled={disabled}>
          <StopIcon />
        </IconButton>
        <IconButton title={micActive ? 'Deactivate microphone' : 'Activate microphone'} onClick={onMicClick} active={micActive}>
          <MicIcon />
        </IconButton>
        <IconButton title="Volume mixer" onClick={onVolumeClick} active={activePanel === 'mixer'}>
          <VolumeIcon />
        </IconButton>
        <IconButton title="Settings" onClick={onSettingsClick} active={activePanel === 'settings'}>
          <GearIcon />
        </IconButton>
      </div>

      <div className="bottom-icon-bar__middle" aria-label="Seek">
        <div className="transport-bar__time">
          {Number.isFinite(currentTime) ? currentTime.toFixed(1) : '0.0'}s / {safeDuration.toFixed(1)}s
        </div>
        <input
          className="transport-bar__slider"
          type="range"
          min={0}
          max={safeDuration}
          step={0.05}
          value={Math.max(0, Math.min(safeDuration, Number.isFinite(currentTime) ? currentTime : 0))}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          disabled={disabled || safeDuration <= 0}
          aria-label="Seek"
        />
      </div>
    </div>
  )
})


