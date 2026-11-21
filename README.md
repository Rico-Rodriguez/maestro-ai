# Maestro AI

Piano practice app. The website is the GitHub Pages build. The iOS app is an unsigned Capacitor build published as `MaestroAI.ipa` on the `ios-v1` pre-release.

## Piano samples

The website plays a 25-note Salamander subset (`public/audio/salamander/`).

The iOS app plays a larger slice of **Salamander Grand Piano V3** by Alexander Holm, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). It keeps six velocity layers, a sample at least every minor third from A0 to C8, hammer-release samples, sympathetic-resonance releases, and sustain-pedal noise. The files are mono AAC so the app stays small. See `ios/audio/grand/CREDITS.txt`.

The iOS reverb is a short concert-hall impulse from the Kajahdus “Konsa” set, recorded at the Helsinki Conservatory of Music by lehtoroni and released [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The dry piano still goes through the same gentle compressor as the website, with the hall on a send.
