# Choir Practice Tool

Ett webbaserat övningsverktyg för körsångare byggt med React, TypeScript och Vite.

## Kom igång

### Installation

```bash
npm install
```

### Utveckling

Starta utvecklingsservern:

```bash
npm run dev
```

Öppna [http://localhost:5173](http://localhost:5173) i din webbläsare.

### Bygga för produktion

```bash
npm run build
```

### Förhandsgranska produktionsbygge

```bash
npm run preview
```

## Projektstruktur

```
src/
├── components/
│   ├── ScorePlayerPage.tsx    # Huvudkomponent för notspelaren
│   └── ScorePlayerPage.css    # Styling för ScorePlayerPage
├── App.tsx                    # Huvudapp-komponent
├── App.css                    # App-specifik styling
├── main.tsx                   # Entry point
└── index.css                  # Global styling
```

## Teknisk stack

- **React 18** - UI-bibliotek
- **TypeScript** - Typsäkerhet
- **Vite** - Byggverktyg och utvecklingsserver
- **CSS** - Styling (inga externa ramverk ännu)

## Nästa steg

Projektet är förberett för att byggas vidare med:
- Notvisning i `#score-container`
- Kontroller i sidopanelen
- Ljuduppspelning och synkronisering

## Design
se filen design.md
