# ClipForge Events (Overwolf app)

Sends your kills from Overwolf's game events to ClipForge, so auto-clip works in
Valorant, Fortnite, Apex Legends, Rainbow Six Siege, Overwatch, Rocket League
(goals) and Marvel Rivals. ClipForge still does all the recording.

## Load it

1. Overwolf only loads unpacked apps for whitelisted developers. Apply once at
   https://www.overwolf.com/app-creation (free) and wait for approval.
2. Overwolf tray icon → Settings → Support → Development options → **Load unpacked
   extension** → pick this `overwolf` folder.
3. In ClipForge: Settings → turn on **Auto-clip kills** and **Overwolf game events**.
   It shows "Connected" once the app has checked in.

## Add a game

Add an entry to `GAMES` in `background.js` and its id to the three lists in
`manifest.json`. The id is the Overwolf game id divided by 10. Look it up in
`%LOCALAPPDATA%/Overwolf/GamesList.*.xml`. Event names are listed at
https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/.
Then reload the app from the Development options window.
