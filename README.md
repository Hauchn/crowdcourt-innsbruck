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
