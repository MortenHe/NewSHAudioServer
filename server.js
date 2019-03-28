//Mplayer + Wrapper anlegen
const createPlayer = require('mplayer-wrapper');
const player = createPlayer();

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//filesystem fuer Playlist
const fs = require('fs-extra');

//Befehle auf Kommandzeile ausfuehren
const { execSync } = require('child_process');

//Lautstaerke zu Beginn auf 100% setzen
let initialVolumeCommand = "sudo amixer sset PCM 100% -M";
console.log(initialVolumeCommand)
execSync(initialVolumeCommand);

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus / Random merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
currentVolume = 50;
currentPosition = 0;
currentPaused = false;
currentRandom = false;
currentFiles = [];

//Player zu Beginn auf 50% stellen
player.setVolume(currentVolume);

//Jede Sekunde die aktuelle Zeit innerhalb des Tracks liefern -> damit playlist-finish getriggert wird
setInterval(() => {
    player.getProps(['time_pos']);
}, 1000);

//Wenn Playlist (=einzelner Song) fertig ist
player.on('playlist-finish', () => {
    console.log("playlist finished");

    //Wenn normale Reihenfolge gespielt wird, zum naechsten Titel gehen
    if (!currentRandom) {
        currentPosition = (currentPosition + 1) % currentFiles.length;
    }

    //bei random zufaelligen Titel auswaehln
    else {
        currentPosition = Math.floor(Math.random() * (currentFiles.length - 1));
    }

    //Infos in JSON schreiben
    writeSessionJson();

    //Clients informieren, dass Playlist fertig ist (position -1)
    sendClientInfo([{
        type: "set-position",
        value: currentPosition
    }]);

    //Naechste Datei abspielen
    playFile();
});

//Infos aus letzter Session auslesen, falls die Datei existiert
if (fs.existsSync('./lastSession.json')) {
    console.log("resume from last session");

    //JSON-Objekt aus Datei holen
    const lastSessionObj = fs.readJsonSync('./lastSession.json');

    //Laden, ob Randon ist
    currentRandom = lastSessionObj.random;

    //letzte Position in Playlist laden
    currentPosition = lastSessionObj.position;
}

//Dateien aus Playlist-textfile in Array laden
fileData = fs.readFileSync("shplaylist.txt");
currentFiles = fileData.toString().split("\n");

//Song starten
playFile();

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn WS eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        var obj = JSON.parse(message);

        //Werte auslesen
        let type = obj.type;
        let value = obj.value;

        //Array von MessageObjekte erstellen, die an WS gesendet werden
        let messageObjArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //Song wurde vom Nutzer weitergeschaltet
            case 'change-item':
                console.log("change-item " + value);

                //wenn normale Reihenfolge gespielt wird
                if (!currentRandom) {

                    //wenn der naechste Song kommen soll
                    if (value) {
                        currentPosition = (currentPosition + 1) % currentFiles.length;
                    }

                    //der vorherige Titel soll kommen
                    else {
                        currentPosition = (currentPosition - 1) % currentFiles.length;
                    }
                }

                //bei random zufaelligen Song auswaehlen
                else {
                    currentPosition = Math.floor(Math.random() * (currentFiles.length - 1));
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Neue Position in Session schreiben
                writeSessionJson();

                //Nachricht an clients, dass nun nicht mehr pausiert ist und wo wir sind
                messageObjArr.push(
                    {
                        type: "set-position",
                        value: currentPosition
                    }, {
                        type: "toggle-paused",
                        value: currentPaused
                    });

                //Datei abspielen
                playFile();
                break;

            //Sprung zu einem bestimmten Titel in Playlist
            case "jump-to":

                //Wohin soll es in Playlist gehen?
                currentPosition = value;
                console.log("jump to " + currentPosition);

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Neue Position in Session schreiben
                writeSessionJson();

                //Nachricht an clients, dass nun nicht mehr pausiert ist und wo wir nun sind
                messageObjArr.push(
                    {
                        type: "set-position",
                        value: currentPosition
                    }, {
                        type: "toggle-paused",
                        value: currentPaused
                    });

                //Datei abspielen
                playFile();
                break;

            //Pause-Status toggeln
            case 'toggle-paused':

                //Pausenstatus toggeln
                currentPaused = !currentPaused;

                //Pause toggeln
                player.playPause();

                //Nachricht an clients ueber Paused-Status
                messageObjArr.push({
                    type: "toggle-paused",
                    value: currentPaused
                });
                break;

            //Random toggle
            case 'toggle-random':

                //Random-Wert togglen
                currentRandom = !currentRandom;

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Random Info in Session schreiben
                writeSessionJson();

                //Nachricht an clients ueber aktuellen Random-Wert und file-list
                messageObjArr.push(
                    {
                        type: type,
                        value: currentRandom
                    }, {
                        type: "toggle-paused",
                        value: currentPaused
                    });
                break;

            //Lautstaerke aendern
            case 'change-volume':

                //Wenn es lauter werden soll, max. 100 setzen
                if (value) {
                    currentVolume = Math.min(100, currentVolume + 10);
                }

                //es soll leiser werden, min. 0 setzen
                else {
                    currentVolume = Math.max(0, currentVolume - 10);
                }

                //Lautstaerke setzen
                console.log("change volume to " + currentVolume);
                player.setVolume(currentVolume);

                //Nachricht mit Volume an clients schicken 
                messageObjArr.push({
                    type: type,
                    value: currentVolume
                });
                break;

            //System herunterfahren
            case "shutdown":
                console.log("shutdown");

                //Shutdown-Info an Clients schicken
                sendClientInfo([{
                    type: "shutdown",
                    value: ""
                }]);

                //Pi herunterfahren
                execSync("shutdown -h now");
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageObjArr);
    });

    //WS einmalig bei der Verbindung ueber div. Wert informieren
    let WSConnectObjectArr = [{
        type: "change-volume",
        value: currentVolume
    }, {
        type: "set-position",
        value: currentPosition
    }, {
        type: "toggle-paused",
        value: currentPaused
    }, {
        type: "toggle-random",
        value: currentRandom
    }, {
        type: "set-files",
        value: currentFiles
    }];

    //Ueber Objekte gehen, die an WS geschickt werden
    WSConnectObjectArr.forEach(messageObj => {

        //Info an WS schicken
        ws.send(JSON.stringify(messageObj));
    });
});

//Datei abspielen
function playFile() {
    console.log("playfile " + currentFiles[currentPosition]);

    //Datei laden und starten
    player.exec('loadfile "' + currentFiles[currentPosition] + '"');
}

//Infos der Session in File schreiben
function writeSessionJson() {
    console.log("write position " + currentPosition + " to session file");
    console.log("write random " + currentRandom + " to session file");

    //Position in Playlist zusammen mit anderen Merkmalen merken fuer den Neustart
    fs.writeJsonSync('./lastSession.json', {
        random: currentRandom,
        position: currentPosition
    });
}

//Infos ans WS-Clients schicken
function sendClientInfo(messageObjArr) {

    //Ueber Liste der MessageObjekte gehen
    messageObjArr.forEach(messageObj => {

        //Ueber Liste der WS gehen und Nachricht schicken
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    });
}