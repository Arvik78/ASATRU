# ASATRU - Air-Gapped Bitcoin Cold Storage
---
ASATRU is a secure, air-gapped Bitcoin cold storage solution that supports Bitcoin and Counterparty.

## Installation Instructions
---
```
Windows : Download ASATRU.exe, run it, complete the installer.
Mac/OSX : Download ASATRU.dmg, mount, and drag ASATRU app to 'Applications' folder
Linux   : Download ASATRU.tgz, extract it, run ASATRU/install.sh
```

## Build Notes
---
The majority of the building is done via nw-builder :

```shell
npm install nw-builder
```

Edit `build.sh` and change your Mac Developer Identity

Run `build.sh` to handle generating builds on Mac/OSX

Download and copy ffmpeg libraries to latest nwjs cache/* directories

https://github.com/nwjs-ffmpeg-prebuilt/nwjs-ffmpeg-prebuilt/releases

## Generate checksum.txt file 
---
```
sha256sum ASATRU.linux32.tgz > checksums.txt
sha256sum ASATRU.linux64.tgz >> checksums.txt
sha256sum ASATRU.osx64.dmg   >> checksums.txt
sha256sum ASATRU.win32.exe   >> checksums.txt
sha256sum ASATRU.win64.exe   >> checksums.txt
```