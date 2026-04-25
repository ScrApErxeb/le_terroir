# Le Terroir - Build EXE

## Prerequis

- Node.js installe
- npm installe

## Installation

```powershell
npm install
```

## Lancer en mode dev

```powershell
npm start
```

## Generer un executable Windows (.exe)

```powershell
npm run build:exe
```

Le fichier sera cree ici:

- `dist/le_terroir.exe`

## Notes importantes

- En mode `.exe`, la base SQLite est stockee a cote de l'executable:
  - `dist/data.db`
- Si `data.db` n'existe pas, il sera cree automatiquement au premier lancement.
