# Tot Quadra

Web per escoltar una ràdio (Catalunya Ràdio, RAC1, Tarragona Ràdio, qualsevol emissora MP3/AAC…)
amb un retard fix respecte al seu directe, per quadrar-la amb el futbol que mires en streaming.

## Fer-la servir

Obre <https://angeldenom.github.io/tot-quadra/>, tria l'emissora, prem **Engega** i ajusta el retard
fins que la ràdio quadri amb la imatge (o fes servir el calibratge ràpid amb les tecles **R** i **V**).

Per provar-la en local cal servir-la per HTTP, perquè usa mòduls JS:

```sh
python3 -m http.server 8000   # i obre http://localhost:8000
```

## Com funciona

- Es descarrega el flux de la ràdio amb `fetch` i es descodifica amb WebCodecs (`AudioDecoder`).
- Per a cada tros d'àudio s'estima l'instant en què era en directe: `directe(t) = min(arribada − t) + t`,
  on `t` són els segons d'àudio rebuts. El mínim descarta les esperes de xarxa i la "ràfega" inicial
  (molts servidors envien 4–10 s d'àudio antic en connectar).
- Cada tros es programa a l'AudioContext perquè soni exactament a `directe + retard`. Si la connexió
  es talla o triga, el retard no canvia: en reconnectar, l'àudio continua al mateix punt.
- Es guarden ~60 s d'historial addicional, de manera que augmentar o reduir el retard és instantani.

## Limitacions

- L'emissora ha de permetre CORS (les principals catalanes ho fan). Si no, caldria un petit proxy.
- Les emissores `http://` no funcionen si la pàgina se serveix per `https://` (contingut mixt).
- De moment no suporta fluxos HLS (`.m3u8`).
- StreamTheWorld (RAC1) talla els navegadors als 32 KB si la petició no porta `Range: bytes=0-`; ja s'hi envia.

## Llicència

[MIT](LICENSE)
