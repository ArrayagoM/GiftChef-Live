# Operación en vivo, pruebas y problemas conocidos

## Antes de transmitir

1. **Prueba sin live:** `cd bridge && npm run mock` y abrí el juego: deberías ver pedidos, taps y voz.
2. **Usuario correcto:** en el menú del juego la casilla debe decir **tu** usuario. Unity recuerda el último usado (clave `tiktokUser` de PlayerPrefs); si quedó el de una prueba, el juego se conecta al live equivocado y "no reacciona a nada".
3. **Captura:** en TikTok LIVE Studio/OBS capturá **solo la ventana del juego** (no el panel) y **activá el audio del escritorio**: la voz del presentador sale por el panel y, sin audio de escritorio, el público ve un cocinero mudo.
4. **Panel abierto:** el cartel superior muestra *"Último evento real hace X s"* con taps, chat, regalos y seguidores reales. Naranja = TikTok no está mandando datos.
5. Requisitos de la cuenta para recibir regalos (seguidores/edad) los fija TikTok y cambian: verificalos en la app.

## Pruebas manuales

```bash
# eventos simulados contra el puente (WebSocket local)
node -e "const W=require('ws');const w=new W('ws://localhost:8080');w.on('open',()=>{w.send(JSON.stringify({type:'ctl',action:'sim',what:'chat',user:'Ana',text:'quiero una pizza'}));setTimeout(()=>process.exit(),500)})"
```

`what`: `chat` (con `text`), `gift` (`gift`, `diamonds`, `count`), `like` (`count`, `total`), `join`, `follow`, `crowd`.

## Procesos y supervisión (opcional)

- `lanzadores/INICIAR COCINA.bat`: servidor `:8081`, panel y juego (ventana chica).
- `lanzadores/INICIAR LIVE AUTOMATICO.bat` + `VIGILANTE.ps1`: revisa cada 15 s que servidor, puente, panel y juego estén abiertos y **reabre lo que se cierre**. Es útil para dejarlo solo, pero **también reabre lo que cerrás a mano**: para parar todo usá `DETENER COCINA.bat` (apaga el vigilante primero).
- El vigilante no usa WMI/CIM (en algunas PCs tarda minutos) y se identifica con un mutex `Global\CocinaTinTechVigilante`.

## Problemas conocidos

- **Conexión pegada a una sala vieja.** Tras cortar y reiniciar el live, el conector puede quedar "conectado" a la sala anterior y no recibir nada. Mitigación: reinicio del proceso tras 10 min sin eventos, y tras dos errores `illegal secret key`.
- **Límites de TikTok.** Reconectar muchas veces seguidas o consultar de más puede hacer que TikTok limite (403/429) o cierre la conexión. El puente espera entre intentos, pero un ciclo de reinicios puede aun así ser demasiado.
- **Sanciones de la plataforma.** Un live puede ser suspendido por reglas de la comunidad o por derechos de autor (personajes/música). Leé el aviso de TikTok y adaptá contenido.
- **Unity se "cuelga" solo.** Casi siempre es un diálogo modal sin responder (*Recovering Scene Backups*, *Moving file failed*). Respondelo (No / Try Again). Las compilaciones por línea de comandos fallan si hay un diálogo abierto.
- **Contadores.** Los taps usan `totalLikeCount` de TikTok; si no viene, se suman los toques recibidos.
- **Audio.** El navegador necesita `--autoplay-policy=no-user-gesture-required` (los lanzadores ya lo usan).
- **Modelos.** Algunos modelos descargados venían acostados o rotos y se corrigen por entrada (`pitch`, `yaw`); ver [ASSETS-Y-CREDITOS.md](ASSETS-Y-CREDITOS.md).

## Qué falta

- Probar el flujo completo con audiencia real sostenida (varias horas) y medir retención.
- Más cocineros, animaciones propias para criaturas y objetos de cocina.
- Un supervisor que verifique *datos* (no solo procesos abiertos) y avise si algo se queda sin eventos.
