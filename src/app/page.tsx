export default function HomePage() {
  return (
    <div style={{ padding: 16 }}>
      <h1>Choir Practice Tool</h1>
      <p>
        Play locally or log in to access groups.
      </p>
      <p>
        <a href="/play">Play (local file)</a> · <a href="/auth">Log in</a> · <a href="/groups">My groups</a>
      </p>
    </div>
  )
}


