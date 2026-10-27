# Arquitectura

## Vista general

| Pieza | Tecnología | Puerto | Rol |
|---|---|---|---|
| `bridge/index.js` | Node.js + `tiktok-live-connector` + `ws` | WS `8080` | Se conecta al live, normaliza eventos y los difunde a todos los clientes |
| `bridge/presenter.js` | Node.js | – | Presentador: cola de frases con prioridad, saludos, agradecimientos, chat, IA |
| `bridge/web-server.js` | Node.js (http) | `8081` | Sirve el panel y `/tts` (voz neuronal) |
| `bridge/tts-service.js` | `msedge-tts` | – | Voces neuronales con caché, cola y reintentos |
| `web/panel.html` + `panel.js` | JS | – | Reproduce la voz, panel de control, calibrador de voz, contador de eventos reales |
| `unity-game/` | Unity 6000.3 (URP) | – | Juego 3D que reacciona a los eventos |

## Protocolo (WebSocket `ws://localhost:8080`)

Mensajes JSON del puente hacia los clientes:

```jsonc
{ "type": "chat" | "gift" | "like" | "join" | "follow",
  "user": "nombre", "userId": "id", "text": "...",
  "giftName": "Rose", "diamonds": 1, "count": 1,
  "total": 772,            // solo en "like": total de taps del live según TikTok
  "ts": 1760000000000 }
{ "type": "say", "id": 12, "text": "…", "kind": "gift|order|hello|likes|loyal|…", "voice": { "prefer": [], "pitch": 1.3, "rate": 1.1 } }
{ "type": "speaking", "state": "start|end", "id": 12 }
{ "type": "status", "text": "tiktok_connected | user:<nombre> | stream_end …" }
{ "type": "catalog_chars", "current": "ash", "characters": [ … ] }
```

Mensajes de control hacia el puente (el panel y el juego los usan):

```jsonc
{ "type": "ctl", "action": "setCharacter", "id": "ash" }
{ "type": "ctl", "action": "rename", "id": "ash", "name": "Chef Marcos" }
{ "type": "ctl", "action": "sim", "what": "chat|gift|like|join|follow|crowd", "user": "Ana", "text": "pizza", "total": 772 }
{ "type": "setUser", "user": "otrousuario" }     // cambia de live sin reiniciar
```

Los mensajes `sim` generan eventos con `userId` que empieza con `sim_` (sirven para probar sin live).

## El puente (`bridge/index.js`)

- **Eventos limpios:** deduplica por `msgId`, descarta el historial inicial de TikTok hasta confirmar la conexión y mide el retraso de cada mensaje.
- **Reconexión prudente:** si el live no empezó, reintenta cada 20 s (primeras 15 veces) y luego cada 60 s; si TikTok limita las consultas (403/429) espera cada vez más.
- **Conexión con tiempo límite:** `connect()` se corta a los 25 s para no colgarse.
- **Vigilante de silencio:** si está "conectado" pero pasan 10 min sin ningún evento, el proceso se reinicia solo (un supervisor lo reabre limpio). Detecta conexiones pegadas a una sala vieja.
- **Registro en disco:** `logs/bridge-AAAA-MM-DD.log`.

## El presentador (`bridge/presenter.js`)

- **Cola con prioridad** (`test > greet > gift > chat > ai > likes > promo`) y tope de frases; las viejas caducan.
- **Respuesta inmediata** a pedidos por chat (`orderDish()` reconoce pizza/hamburguesa/papas/dona con errores de tipeo, emojis y cantidades) y a regalos (espera de 250 ms para juntar ráfagas).
- **IA opcional** (Groq `gpt-oss-120b` o Claude): responde mensajes largos con límites por minuto y filtro de contenido; las respuestas armadas cubren lo corto.
- **Taps:** agradece cada ~20 s nombrando a quien más tocó. **Fidelidad:** nombra al espectador activo con más de 5 min.
- **Voz por personaje:** `config/characters.json` define voz preferida, tono y velocidad; se recuerda el último cocinero en `config/last-character.json`.

## El juego (`unity-game/Assets/Scripts`)

| Script | Qué hace |
|---|---|
| `BridgeClient` | Cliente WebSocket; traduce eventos a acciones del juego |
| `KitchenController` | Cola de pedidos (`Job`), recetas (pizza, hamburguesa, papas, dona), horno con puerta animada, pala, embalaje, pedidos por chat |
| `ChefAnimator` | Movimiento y rutas del cocinero, **IK de manos y codos**, inclinación sobre la mesa |
| `OrderBoard` | Pizarra de pedidos (un renglón por pedido) |
| `GoalHud` | Panel de **rondas de taps** (meta absoluta sobre el total real del live), cuenta regresiva y evento especial (lluvia de pizzas) |
| `PokemonSpawner` | Criaturas según regalos, premios por rondas/seguidores, entrada, animaciones y mascota residente |
| `EpicFx` | Secuencia cinematográfica: círculo mágico, rayos, destello, cámara lenta, título, posproceso (bloom, viñeta) generado por código |
| `FollowCamera` | Cámara con planos bloqueables, cortes secos y temblor |
| `StartMenu` | Menú inicial (usuario de TikTok, cocinero), recuerda las últimas elecciones; `-autostart` arranca solo |
| `SubtitleBar`, `ConnectionPanel`, `KitchenNav`, `PerformanceSettings`, `BridgeLauncher` | Subtítulos, estado de conexión, navegación, límite de FPS, arranque del puente |

### Reglas de juego (valores por defecto)

- **Platos:** Rose = pizza, Heart / Finger Heart = hamburguesa, Doughnut = papas, GG = dona. Por chat: `pizza`, `hamburguesa`, `papas`, `dona`.
- **Pedidos:** cada pedido es un renglón; solo se junta con el anterior una ráfaga de regalos de menos de 3 s. Por chat: mismo plato repetido solo cada 15 s y hasta 3 pendientes por persona.
- **Rondas de taps:** metas absolutas 600, 2600, 5600, 9600, 14600… Premio: ronda 1 normal, 2 raro, 3 épico, 4+ legendario. El contador sigue el total real que informa TikTok.
- **Criaturas por regalo:** `config/pokemon.json` define probabilidades por rango de diamantes, topes simultáneos, tiempos y combo legendario por regalos acumulados.
- **Evento especial:** cada 300 s (`GoalHud.eventEvery`).

## Archivos de prueba (carpeta del juego compilado)

- `spawn-test.txt` con un id (`lugia`) → aparece esa criatura.
- `event-test.txt` → dispara el evento especial.
- Argumentos: `-autostart`, `-screen-fullscreen 0 -screen-width 540 -screen-height 960`.
