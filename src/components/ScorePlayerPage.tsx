import './ScorePlayerPage.css'

function ScorePlayerPage() {
  return (
    <div className="score-player-page">
      <header className="top-bar">
        <h1>Choir Practice Tool</h1>
      </header>
      
      <main className="main-content">
        <div className="score-section">
          <div id="score-container" className="score-container">
            <p>Notvisning kommer här</p>
          </div>
        </div>
        
        <aside className="control-panel">
          <h3>Kontroller</h3>
          <p>Kontroller kommer här</p>
        </aside>
      </main>
    </div>
  )
}

export default ScorePlayerPage