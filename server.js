//Mplayer + Wrapper anlegen
const createPlayer = require('mplayer-wrapper');
const player = createPlayer();

//WebSocketServer anlegen und starten
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 9090, clientTracking: true });

//filesystem, random und Array-Elemente verschieben fuer Playlist
const fs = require('fs-extra');
const path = require('path');
const shuffle = require('shuffle-array');
const arrayMove = require('array-move');

//Aus Config auslesen wo die Audio-Dateien liegen
const configFile = fs.openSync("config.json");
const audioDir = configFile["audioDir"];

//Befehle auf Kommandzeile ausfuehren (volume)
const { execSync } = require('child_process');

//Aktuelle Infos zu Volume / Playlist / PausedStatus / damit Clients, die sich spaeter anmelden, diese Info bekommen
var data = [];
data["volume"] = 80;
data["files"] = [];
data["paused"] = false;
data["insertIndex"] = 1;

//initiale Lautstaerke setzen
setVolume();

//Jede Sekunde die aktuelle Zeit innerhalb des Tracks liefern -> damit playlist-finish getriggert wird
setInterval(() => {
    player.getProps(['time_pos']);
}, 1000);

//Wenn Playlist (=einzelner Song) fertig ist
player.on('playlist-finish', () => {
    console.log("playlist finished");

    //In Playlist einen Schritt weitergehen
    shiftArray(1);

    //insertOffset um 1 verkleinern, wenn Offset gesetzt ist
    if (data["insertIndex"] > 1) {
        data["insertIndex"] = data["insertIndex"] - 1;
    }

    //Clients informieren ueber files und inserOffset informieren
    sendClientInfo(["files", "insertIndex"])

    //Datei abspielen
    playFile();
});

//alle mp3-Dateien in diesem Dir-Tree ermitteln und playlist random erstellen
const allFiles = getAudioFiles(audioDir);
data["files"] = shuffle(allFiles);

//1. Song starten
playFile();

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn Client eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        var obj = JSON.parse(message);
        let type = obj.type;
        let value = obj.value;

        //Array von Messages erstellen, die an Client gesendet werden
        let messageArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //Song wurde vom Nutzer weitergeschaltet
            case 'change-item':

                //wenn der naechste Song kommen soll, insertOffeset berechnen
                if (value === 1) {
                    data["insertIndex"] = data["insertIndex"] > 1 ? data["insertIndex"] - 1 : 1;
                }

                //wenn der vorherige Song kommen soll, insertOffeset berechnen
                else {
                    data["insertIndex"] = data["insertIndex"] < data["files"].length ? data["insertIndex"] + 1 : data["insertIndex"];
                }

                //Titel-Array neu erzeugen
                shiftArray(value);

                //Es ist nicht mehr pausiert
                data["paused"] = false;

                //Song abspielen und Nachricht an clients
                playFile();
                messageArr.push("files", "paused", "insertIndex");
                break;

            //Sprung zu einem bestimmten Titel in Playlist
            case "jump-to":

                //Playlist neu erstellen, damit neu gewaehlter Titel an 1. Stelle steht
                shiftArray(value);

                //Falls man nicht ueber insertIndex springt -> insertIndex erhalten
                if (value < data["insertIndex"]) {
                    data["insertIndex"] = data["insertIndex"] - value;
                }

                //es wurde ueber den uebersprungen -> insertIndex zuruecksetzen 
                else {
                    data["insertIndex"] = 1;
                }

                //Es ist nicht mehr pausiert
                data["paused"] = false;

                //Song abspielen und clients informieren
                playFile();
                messageArr.push("files", "paused", "insertIndex");
                break;

            //Pause-Status toggeln
            case 'toggle-paused':

                //Pausenstatus toggeln, Player-Pause toggeln und clients informieren
                data["paused"] = !data["paused"];
                player.playPause();
                messageArr.push("paused");
                break;

            //Titel einreihen
            case 'enque-title':

                //Wo soll Titel einfuegt werden?
                let tempInsertIndex = data["insertIndex"];

                //Wenn eingereihter Titel hinter Einfuegemarke liegt, Einfuegemarke nach hinten verschieben
                if (value >= data["insertIndex"]) {
                    data["insertIndex"]++;
                }

                //eingereihter Titel liegt vor der Einfuegemarke, Einfuegeindex einen Stelle vorher
                else {
                    tempInsertIndex--;
                }

                //Titel an passende Stelle in playlist verschieben
                data["files"] = arrayMove(data["files"], value, tempInsertIndex);

                //Clients informieren
                messageArr.push("files", "insertIndex");
                break;

            //Lautstaerke aendern
            case 'change-volume':

                //Wenn es lauter werden soll, max. 100 setzen
                if (value) {
                    data["volume"] = Math.min(100, data["volume"] + 10);
                }

                //es soll leiser werden, min. 0 setzen
                else {
                    data["volume"] = Math.max(0, data["volume"] - 10);
                }

                //Lautstaerke setzen und clients informieren
                setVolume();
                messageArr.push("volume");
                break;

            //System herunterfahren
            case "shutdown":
                console.log("shutdown");

                //Shutdown-Info an Clients schicken
                sendClientInfo("shutdown");

                //Pi herunterfahren
                execSync("shutdown -h now");
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageArr);
    });

    //Clients einmalig bei der Verbindung ueber div. Wert informieren
    let WSConnectMessageArr = ["volume", "paused", "files", "insertIndex"]

    //Ueber Messages gehen, die an WS geschickt werden
    WSConnectMessageArr.forEach(message => {

        //Message-Object erzeugen und an Client schicken
        let messageObj = {
            "type": message,
            "value": data[message]
        };
        ws.send(JSON.stringify(messageObj));
    });
});

//Datei abspielen (immer 1. Datei, da aktueller Titel oben steht und playlist entsprechend angepasst wird)
function playFile() {
    console.log("playfile " + data["files"][0]);

    //Datei laden und starten
    player.exec('loadfile "' + data["files"][0] + '"');
}

//Infos ans WS-Clients schicken
function sendClientInfo(messageArr) {

    //Ueber Liste der Messages gehen
    messageArr.forEach(message => {

        //Message-Object erzeugen
        let messageObj = {
            "type": message,
            "value": data[message]
        };

        //Ueber Liste der Clients gehen und Nachricht schicken
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    });
}

//Anfangspunkt eines Arrays verschieben: [1, 2, 3, 4, 5] => [3, 4, 5, 1, 2]
function shiftArray(splitPosition) {
    data["files"] = data["files"].slice(splitPosition).concat(data["files"].slice(0, splitPosition));
}

//Lautstaerke setzen
function setVolume() {
    let initialVolumeCommand = "sudo amixer sset Digital " + data["volume"] + "% -M";
    console.log(initialVolumeCommand)
    execSync(initialVolumeCommand);
}

//Playlist erstellen: dazu rekursiv ueber Verzeichnisse gehen
function getAudioFiles(dir) {

    //Ergebnisse sammeln
    let results = [];

    //Dateien in Verzeichnis auflisten
    let list = fs.readdirSync(dir);

    //Ueber Dateien iterieren
    list.forEach(function (file) {

        //Infos ueber Datei holen
        file = path.resolve(dir, file);
        let stat = fs.statSync(file);

        //Wenn es ein Verzeichnis ist -> Unterverzeichnis aufrufen
        if (stat && stat.isDirectory()) {
            results = results.concat(getAudioFiles(file));
        }

        //es ist eine Datei -> nur mp3-Dateien sammeln
        else {
            if (path.extname(file).toLowerCase() === '.mp3') {
                results.push(file);
            }
        }
    });

    //Datei-Liste zurueckgeben
    return results;
}