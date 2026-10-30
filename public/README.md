# AskMe

Live voting: vragenlijst maken → QR-code tonen → deelnemers stemmen op hun telefoon (PWA) → resultaten live op het scherm.

## Starten (Docker)
```bash
cp .env.example .env      # zet ADMIN_PASSWORD en PUBLIC_URL
docker compose up -d --build
```
Open `http://<host>:3000/admin`. Data staat in volume `askme-data` (SQLite).

Zonder Docker: `npm ci && ADMIN_PASSWORD=... node server.js`

**Productie:** zet er een reverse proxy met HTTPS voor (Caddy/Traefik/nginx) — PWA en service worker werken alleen over HTTPS. Bij nginx: `proxy_buffering off` voor `/api/polls/*/stream` (live updates via SSE). `PUBLIC_URL` bepaalt de URL in de QR-code.

## Gebruik
- **/admin** — vragenlijsten maken/bewerken, openen/sluiten, CSV-export, antwoorden wissen.
- **/present/:id** — presentatiescherm: QR + live resultaten. Toetsen: ← → vraag wisselen, Q QR verbergen, F fullscreen.
- **/p/:id** — deelnemers (geen login).

Vraagtypes: één keuze, meerdere keuzes, schaal 1–5 / 1–10, rangschikken (2–10 items slepen).
Ranking-score: Borda (1e plaats = n−1 punten … laatste = 0) + gemiddelde plaats.

## Beperkingen (bewust simpel)
- Dubbel stemmen wordt tegengegaan via een anonieme device-ID in de browser. Incognito of andere browser = opnieuw stemmen. Geen echte identiteitscheck.
- Vragen zijn vergrendeld zodra er antwoorden zijn (anders kloppen de resultaten niet meer).
- Eén admin-wachtwoord, sessiecookie 30 dagen. Wachtwoord wijzigen = alle sessies ongeldig.
- Presentatiescherm vereist admin-login.
