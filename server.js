//Mplayer + Wrapper anlegen
const createPlayer = require('mplayer-wrapper');
const player = createPlayer();

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 9090, clientTracking: true });

//Wo liegen Audio-Dateien
const dir = "/media/shplayer";

//filesystem und random fuer Playlist
const fs = require('fs-extra');
const path = require('path');
const shuffle = require('shuffle-array');

//Befehle auf Kommandzeile ausfuehren
const { execSync } = require('child_process');

//Lautstaerke zu Beginn auf 100% setzen
let initialVolumeCommand = "sudo amixer sset PCM 100% -M";
console.log(initialVolumeCommand)
execSync(initialVolumeCommand);

//Aktuelle Infos zu Volume / Position in Song / Position innerhalb der Playlist / Playlist / PausedStatus / damit Clients, die sich spaeter anmelden, diese Info bekommen
currentVolume = 80;
currentPosition = 0;
currentPaused = false;
currentFiles = [];
currentInsertOffset = 0;

//Jede Sekunde die aktuelle Zeit innerhalb des Tracks liefern -> damit playlist-finish getriggert wird
setInterval(() => {
    player.getProps(['time_pos']);
}, 1000);

//Wenn Playlist (=einzelner Song) fertig ist
player.on('playlist-finish', () => {
    console.log("playlist finished");

    //Zum naechsten Titel gehen
    currentPosition = (currentPosition + 1) % currentFiles.length;

    //insertOffset um 1 verkleinern, wenn Offset gesetzt ist
    if (currentInsertOffset > 0) {
        currentInsertOffset = currentInsertOffset - 1;
    }

    //Clients informieren ueber neue Position und inserOffset informieren
    sendClientInfo([{
        type: "set-position",
        value: currentPosition
    },
    {
        type: "set-insert-offset",
        value: currentInsertOffset
    }]);

    //Naechste Datei abspielen
    playFile();
});

//Playlist erstellen: dazu rekursiv ueber Verzeichnisse gehen
var walk = function (dir) {

    //Ergebnisse sammeln
    var results = [];

    //Dateien in Verzeichnis auflisten
    var list = fs.readdirSync(dir);

    //Ueber Dateien iterieren
    list.forEach(function (file) {

        //Infos ueber Datei holen
        file = path.resolve(dir, file);
        var stat = fs.statSync(file);

        //Wenn es ein Verzeichnis ist
        if (stat && stat.isDirectory()) {

            //Unterverzeichnis aufrufen
            results = results.concat(walk(file));
        }

        //es ist eine Datei
        else {

            //nur mp3-Dateien sammeln
            if (path.extname(file).toLowerCase() === '.mp3') {
                results.push(file);
            }
        }
    });

    //Liste zurueckgeben
    return results;
}

//alle mp3-Dateien in diesem Dir-Tree ermitteln
const allFiles = walk(dir);

//Dateien random
currentFiles = shuffle(allFiles);

//1. Song starten
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

                //wenn der naechste Song kommen soll, insertOffeset erhalten
                if (value) {
                    currentPosition = (currentPosition + 1) % currentFiles.length;
                    currentInsertOffset = currentInsertOffset > 0 ? currentInsertOffset - 1 : 0;
                }

                //der vorherige Titel soll kommen, Modulo bei negativen Zahlen, s. https://stackoverflow.com/questions/4467539/javascript-modulo-gives-a-negative-result-for-negative-numbers
                //insertOffeset zuruecksetzen
                else {
                    currentPosition = (((currentPosition - 1) % currentFiles.length) + currentFiles.length) % currentFiles.length;
                    currentInsertOffset = 0;
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients, dass nun nicht mehr pausiert ist und wo wir sind und insertPosition
                messageObjArr.push(
                    {
                        type: "set-position",
                        value: currentPosition
                    }, {
                        type: "toggle-paused",
                        value: currentPaused
                    }, {
                        type: "set-insert-offset",
                        value: currentInsertOffset
                    });

                //Datei abspielen
                playFile();
                break;

            //Sprung zu einem bestimmten Titel in Playlist
            case "jump-to":

                //Falls man nach vorne springt und nicht ueber insertOffset springt -> inesrtOffset erhalten
                if (value < (currentPosition + currentInsertOffset) && value >= currentPosition) {
                    currentInsertOffset = currentInsertOffset - (value - currentPosition);
                    console.log("update insertOffeset " + currentInsertOffset);
                }

                //es wurde zurueckgesprungen oder der insertOffset uebersprungen -> insertOffeset zuruecksetzen 
                else {
                    currentInsertOffset = 0;
                    console.log("reset insertOffset")
                }

                //Wohin soll es in Playlist gehen?
                currentPosition = value;
                console.log("jump to " + currentPosition);

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Nachricht an clients, dass nun nicht mehr pausiert ist und wo wir nun sind, neue Position und insertOffset
                messageObjArr.push(
                    {
                        type: "set-position",
                        value: currentPosition
                    }, {
                        type: "toggle-paused",
                        value: currentPaused
                    }, {
                        type: "set-insert-offset",
                        value: currentInsertOffset
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

            //Playlist, Position und InsertOffset anpassen
            case 'set-files-position-offset':

                //Playlist und Position anpassen (Position kann sich aendern, wenn ein Titel vor dem aktuellen Titel hinten eingereiht wurde)
                currentFiles = value.files;
                currentPosition = value.position
                currentInsertOffset = value.insertOffset
                console.log("new playlist is\n" + currentFiles.join("\n"));
                console.log("new position " + currentPosition);
                console.log("new insertOffeset " + currentInsertOffset);

                //Clients informieren ueber Playlist und Position
                messageObjArr.push(
                    {
                        type: "set-files",
                        value: currentFiles
                    }, {
                        type: "set-position",
                        value: currentPosition
                    }, {
                        type: "set-insert-offset",
                        value: currentInsertOffset
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
        type: "set-files",
        value: currentFiles
    }, {
        type: "set-insert-offset",
        value: currentInsertOffset
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

    //Player auf aktuelle Lautstaerke stellen
    player.setVolume(currentVolume);
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