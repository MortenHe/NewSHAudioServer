#!/bin/bash
/usr/bin/sudo /usr/bin/node /home/pi/mh_prog/NewSHAudioServer/server.js ${1:-''} > /home/pi/mh_prog/output-server.txt &