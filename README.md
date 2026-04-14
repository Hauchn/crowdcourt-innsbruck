# CrowdCourt

Kleine Web-App, die Sportplätze in und um Innsbruck auf einer Karte zeigt:

- Fußball
- Tennis
- Volleyball
- Tischtennis

Die Daten kommen live aus OpenStreetMap über die Overpass API.

## Funktionen

- Filter pro Sportart
- Suche nach Name oder Sportart
- Liste mit gefundenen Plätzen
- Standort nutzen (zeigt Distanz zu Plätzen)
- "Anzeigen" zum Zoomen auf den Platz
- "Route" zum Starten der Navigation in Google Maps

## Start

1. Im Projektordner einen lokalen Server starten:

   ```bash
   python3 -m http.server 8080
   ```

2. Im Browser öffnen:

   [http://localhost:8080](http://localhost:8080)

## Dateien

- `index.html` - Struktur der Seite
- `styles.css` - Layout und Design
- `app.js` - Karte, Filter und API-Abfrage
- `server.js` - API, Crowd-Logik und Agent-Verknüpfung

## Agenten verknüpfen (Sportplätze + Planer)

Neue Endpunkte im Backend:

- `POST /api/agents/sports-places` - lädt Sportplätze in Innsbruck (Overpass, mit Fallback)
- `POST /api/agents/planner` - erstellt einen Plan aus einer übergebenen Platzliste
- `POST /api/agents/compose-plan` - orchestriert beide Agenten in einem Call (Event-Pattern)

Beispiel:

```bash
curl -X POST http://localhost:8080/api/agents/compose-plan \
  -H "Content-Type: application/json" \
  -d '{
    "sports": ["tennis", "soccer"],
    "limit": 5,
    "options": {
      "startHour": "18:30",
      "maxStops": 2,
      "travelMode": "Fahrrad"
    }
  }'
```
