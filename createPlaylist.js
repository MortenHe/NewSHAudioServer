//Zugriff auf Dateien und Pfade
const fs = require('fs-extra');
const path = require('path');

//Wo liegen Audio-Dateien
const dir = "/media/shplayer";

//Rekursiv ueber Verzeichnisse gehen
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

//Liste in txt-Datei schreiben
fs.writeFile('shplaylist.txt', allFiles.join('\n'));