const createPlayer = require('mplayer-wrapper');
const player = createPlayer();
const { spawn } = require('child_process');
const fs = require('fs-extra');
const shuffle = require('shuffle-array');
const arrayMove = require('array-move');
const glob = require('glob');
const singleSoundPlayer = require('node-wav-player');
const exec = require('child_process').exec;

//WebSocketServer anlegen und starten
const port = 9090;
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: port, clientTracking: true });

//Config file laden
const configFile = fs.readJsonSync(__dirname + "/../AudioServer/config.json");
const audioDir = configFile.audioDir;
const audioDirShp = audioDir + "/shp";

//Zeit wie lange bis Shutdown durchgefuhert wird bei Inaktivitaet
const countdownTime = configFile.countdownTime;
var countdownID = null;

//GPIO Buttons starten, falls konfiguriert
if (configFile.GPIOButtons) {
    console.log("Use GPIO Buttons");
    const buttons_gpio = spawn("node", [__dirname + "/../WSGpioButtons/button.js", port]);
    buttons_gpio.stdout.on("data", (data) => {
        console.log("button event: " + data);
    });
}

//USB RFID Reader starten, falls konfiguriert
if (configFile.USBRFIDReader) {
    console.log("Use USB RFID Reader");
    const rfid_usb = spawn("node", [__dirname + "/../WSRFID/rfid.js", port]);
    rfid_usb.stdout.on('data', (data) => {
        console.log("rfid event: " + data);
    });
}

//STT starten, falls konfiguriert
if (configFile.STT) {
    console.log("Use Speach to text");

    //JSON-File fuer Indexerzeugung wird bei AudioServer erstellt (wegen MainJSON)

    //STT-Suche
    const stt_search = spawn("node", [__dirname + "/../WSSTT/stt.js", port]);
    stt_search.stdout.on('data', (data) => {
        console.log("stt search event: " + data);
    });
}

//Aktuelle Infos zu Volume / Playlist / PausedStatus / damit Clients, die sich spaeter anmelden, diese Info bekommen
const data = [];
data["volume"] = configFile.volume;
data["files"] = [];
data["paused"] = false;
data["insertIndex"] = 1;
data["secondsPlayed"] = 0;
data["countdownTime"] = -1;
data["pageTitle"] = configFile.userMode;
data["audioModes"] = fs.readJsonSync(audioDirShp + "/audioModes.json");

//Welcher Audio Mode ist zu Beginn aktiv?
data["audioMode"] = process.argv[2] || configFile.shpAudioMode;
console.log("audioMode is " + data["audioMode"]);

//Modus fuer Autostart merken
writeAutostartFile();

//initiale Lautstaerke setzen
setVolume();

//Jede Sekunde die aktuelle Zeit innerhalb des Titels liefern -> damit playlist-finish getriggert wird
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

//Wenn time_pos property geliefert wird
player.on('time_pos', (totalSecondsFloat) => {

    //Wie viele Sekunden ist der Track schon gelaufen? Float zu int: 13.4323 => 13
    data["secondsPlayed"] = Math.trunc(totalSecondsFloat);
    //console.log("track progress " + data["secondsPlayed"]);
});

//alle mp3-Dateien in diesem Modus (Unterordner) ermitteln und random list erstellen
getAudioFiles();

//1. Song starten
playFile();

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Wenn Client eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        const obj = JSON.parse(message);
        const type = obj.type;
        const value = obj.value;

        //Array von Messages erstellen, die an Client gesendet werden
        const messageArr = [];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //Pause, wenn Playlist gerade laeuft
            case 'pause-if-playing':

                //Wenn wir gerade in der Playlist sind und nicht pasuiert ist -> pausieren
                if (data["position"] !== -1 && !data["paused"]) {
                    data["paused"] = true;
                    player.playPause();
                    messageArr.push("paused");
                    startCountdown();
                }
                break;

            //Pause-Status toggeln
            case 'toggle-paused':

                //Pausenstatus toggeln, Player-Pause toggeln und clients informieren
                data["paused"] = !data["paused"];
                player.playPause();
                playSound("pause");
                messageArr.push("paused");

                //Wenn jetzt pausiert ist, Countdown starten
                if (data["paused"]) {
                    startCountdown();
                }

                //Pausierung wurde beendet -> Countdown beenden
                else {
                    resetCountdown();
                }
                break;

            //Song wurde vom Nutzer weitergeschaltet
            case 'change-item':
                resetCountdown();

                //wenn der naechste Song kommen soll, insertOffeset berechnen und Titel-Array neu erzeugen
                if (value === 1) {
                    data["insertIndex"] = data["insertIndex"] > 1 ? data["insertIndex"] - 1 : 1;
                    shiftArray(value);
                    playSound("track-next");
                }

                //wenn der previous Button gedrueckt wurden
                else {

                    //Wenn weniger als x Sekunden vergangen sind -> zum vorherigen Titel springen, insertOffeset berechnen und Titel-Array neu erzeugen
                    if (data["secondsPlayed"] < 7) {
                        console.log("go to previous track")
                        data["insertIndex"] = data["insertIndex"] < data["files"].length ? data["insertIndex"] + 1 : data["insertIndex"];
                        shiftArray(value);
                        playSound("track-prev");
                    }

                    //Titel ist schon mehr als x Sekunden gelaufen -> Titel nochmal von vorne starten
                    //Gespielte Sekunden manuell auf 0 setzen. Damit mit schnellen Klicks der vorherige Titel ausgewaehlt werden kann
                    else {
                        console.log("repeat current track");
                        data["secondsPlayed"] = 0;
                        playSound("track-same");
                    }
                }

                //Song abspielen und Nachricht an clients
                data["paused"] = false;
                playFile();
                messageArr.push("files", "paused", "insertIndex");
                break;

            //Playlist umsortieren und Clients informieren
            case 'sort-playlist':
                console.log("move item " + value.from + " to " + value.to);
                data["files"] = arrayMove(data["files"], value.from, value.to);
                messageArr.push("files");
                break;

            //Titel aus Playlist als 1. Titel setzen und derzeit 1. Titel an diese Stelle verschieben
            case "jump-to":

                //Countdown abbrechen
                resetCountdown();

                //Ausgewaehlten Titel and 1. Position setzen und anderen Titel dorthin verschieben
                const currentFile = data["files"][0];
                data["files"][0] = data["files"][value];
                data["files"][value] = currentFile

                //Es ist nicht mehr pausiert
                data["paused"] = false;

                //Song abspielen und clients informieren
                playFile();
                messageArr.push("files", "paused", "insertIndex");
                break;

            //Titel einreihen
            case 'enqueue-title':

                //Wo soll Titel einfuegt werden?
                const tempInsertIndex = data["insertIndex"];

                //Wenn eingereihter Titel hinter Einfuegemarke liegt, Einfuegemarke nach hinten verschieben
                if (value >= data["insertIndex"]) {
                    data["insertIndex"]++;
                }

                //eingereihter Titel liegt vor der Einfuegemarke, Einfuegeindex einen Stelle vorher
                else {
                    tempInsertIndex--;
                }

                //Titel an passende Stelle in Playlist verschieben und Clients informieren
                data["files"] = arrayMove(data["files"], value, tempInsertIndex);
                messageArr.push("files", "insertIndex");
                break;

            //Titel ans Ende der Playlist verschieben
            case 'move-title-to-end':

                //Wenn eingereihter Titel im Einfuegebereich liegt, Einfuegemarke nach vorne verschieben
                if (value < data["insertIndex"]) {
                    data["insertIndex"]--;
                }

                //Titel ans Ende schieben und Clients informieren
                data["files"] = arrayMove(data["files"], value, data["files"].length - 1);
                messageArr.push("files", "insertIndex");
                break;

            //Zwischen Liederlisten wechseln (Musiksammlung SH, MH, Kids)
            case 'set-audio-mode':
                resetCountdown();

                //Wo liegen die Dateien des neuen Modus?
                data["audioMode"] = value.audioMode;
                getAudioFiles();

                //neuen Modus fuer Autostart merken
                writeAutostartFile()

                //Pause und InsertIndex zuruecksetzen
                data["paused"] = false;
                data["insertIndex"] = 1;

                //1. Song starten und Clients informieren
                playFile();
                messageArr.push("files", "audioMode", "paused", "insertIndex");
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
                shutdown();
                break;
        }

        //Infos an Clients schicken
        sendClientInfo(messageArr);
    });

    //Clients einmalig bei der erstmaliger Verbindung ueber div. Wert informieren
    const WSConnectMessageArr = ["volume", "paused", "files", "insertIndex", "audioModes", "audioMode", "pageTitle", "countdownTime"]
    WSConnectMessageArr.forEach(message => {
        const messageObj = {
            "type": message,
            "value": data[message]
        };
        ws.send(JSON.stringify(messageObj));
    });
});

//Datei abspielen (immer 1. Datei, da aktueller Titel oben steht und playlist entsprechend angepasst wird)
function playFile() {
    console.log("load file " + data["files"][0]);

    //Datei laden und starten
    player.exec('loadfile "' + data["files"][0] + '"');
}

//Message-Infos ans WS-Clients schicken
function sendClientInfo(messageArr) {
    messageArr.forEach(message => {
        const messageObj = {
            "type": message,
            "value": data[message]
        };

        //Ueber Liste der Clients gehen und Nachricht schicken
        for (const ws of wss.clients) {
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

//Aktuellen Modus fuer Autostart merken
function writeAutostartFile() {
    fs.writeFile(__dirname + "/../wss-install/last-player", "AUTOSTART=sudo " + __dirname + "/../AudioServer/startnodesh.sh " + data["audioMode"]);
}

//Lautstaerke setzen
function setVolume() {
    if (configFile.audioOutput) {
        const volumeCommand = "amixer sset " + configFile.audioOutput + " " + + data["volume"] + "% -M";
        console.log(volumeCommand);
        exec(volumeCommand);
    }
    else {
        console.log("no audioOutput configured");
    }
}

//Playlist erstellen mit mp3 Files dieses Modes
function getAudioFiles() {
    const allFiles = glob.sync(audioDirShp + "/" + data["audioMode"] + "/**/*.mp3", { nocase: true });
    data["files"] = shuffle(allFiles);
}

//Countdown fuer Shutdown zuruecksetzen und starten, weil gerade nichts mehr passiert
function startCountdown() {
    console.log("start countdown")
    data["countdownTime"] = countdownTime;
    countdownID = setInterval(countdown, 1000);
}

//Countdown fuer Shutdown wieder stoppen, weil nun etwas passiert und Countdowntime zuruecksetzen und Clients informieren
function resetCountdown() {
    console.log("reset countdown");
    clearInterval(countdownID);
    countdownID = null;
    data["countdownTime"] = -1;
    sendClientInfo(["countdownTime"]);
}

//Bei Inaktivitaet Countdown runterzaehlen und Shutdown ausfuehren
function countdown() {

    //Wenn der Countdown noch nicht abgelaufen ist
    if (data["countdownTime"] >= 0) {
        console.log("shutdown in " + data["countdownTime"] + " seconds");

        //Anzahl der Sekunden bis Countdown an Clients schicken
        sendClientInfo(["countdownTime"]);

        //Zeit runterzaehlen
        data["countdownTime"]--;
    }

    //Countdown ist abgelaufen, Shutdown durchfuehren
    else {
        shutdown();
    }
}

//Einzelsound abspielen
function playSound(sound) {
    singleSoundPlayer.play({ path: audioDir + "/sounds/" + sound + ".wav" });
}

//Pi herunterfahren
function shutdown() {
    console.log("shutdown");

    //Shutdown-Info an Clients schicken
    sendClientInfo(["shutdown"]);

    //Pi herunterfahren
    exec("shutdown -h now");
}