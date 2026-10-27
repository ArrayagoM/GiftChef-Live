# GiftChef Live

**Un bot streamer para TikTok LIVE con juegos 3D que reaccionan en tiempo real a los regalos, los toques (taps) y los comentarios del chat.**

El espectador no necesita gastar nada: escribe `pizza` en el chat y el cocinero la prepara; toca la pantalla y llena una barra de metas que invoca criaturas cada vez más poderosas; sigue la cuenta y recibe una sorpresa. Si manda un regalo, el pedido sale al instante. Un presentador con voz propia saluda a los que entran, agradece, conversa con el chat (con IA opcional) y narra todo en vivo.

> Proyecto de **TinTech** (`@tinchotech`). Código bajo licencia MIT. Es un proyecto de fans, **no está afiliado ni respaldado** por TikTok, Nintendo/The Pokémon Company, Toei, ni ninguna otra marca citada. Ver [docs/ASSETS-Y-CREDITOS.md](docs/ASSETS-Y-CREDITOS.md).

## Qué hace

| Evento del live | Reacción del juego |
|---|---|
| **Comentario** "quiero una pizza", `=pizza`, `amburgesa`, `2 papas` 🍕 | Pedido nuevo en la pizarra (gratis, tolera errores de tipeo) y el cocinero responde en milisegundos |
| **Regalo** (Rose, Heart, Doughnut, GG…) | Pedido cocinado paso a paso con animación (amasar, hornear con pala, embalar) |
| **Taps** | Barra de **rondas**: 600 → 2600 → 5600 → 9600… Cada ronda trae un Pokémon más poderoso (normal, raro, épico, legendario) |
| **Seguidor nuevo** | Aparece una criatura y el cocinero lo nombra |
| **Regalo grande** | Criaturas por rareza según los diamantes, con secuencia cinematográfica para las épicas/legendarias (círculo mágico, rayos, destello, cámara lenta, título) |
| **Cada 5 min** | Evento especial: lluvia de pizzas + criaturas, con cuenta regresiva en pantalla |
| **Sin pedidos** | El cocinero limpia la mesa (esponja y burbujas) |
| **Espectadores fieles** | El presentador nombra a quien lleva más de 5 minutos |

Además: 13 cocineros intercambiables con voz propia (Ash, Goku, Vegeta, Luna, Tomás…), nombres editables desde el panel, voz neuronal calibrable (tono y velocidad), cola de frases con prioridades y un panel de control aparte que no se captura en el stream.

## Cómo está armado

```
TikTok LIVE ──► bridge (Node, ws://localhost:8080) ──► Juego Unity (3D)
                    │  ▲                                  ▲
                    │  └── presentador (frases + IA) ─────┘
                    ▼
        servidor web :8081 ──► panel de voz/control (Edge) ──► audio del presentador
```

- **`bridge/`** – Puente en Node.js: se conecta al live con [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector), normaliza los eventos y los reparte por WebSocket. Incluye el presentador (`presenter.js`), el servidor de voz neuronal (`tts-service.js`, `msedge-tts`) y vigilancia de conexión.
- **`unity-game/`** – Juego en Unity 6 (URP): cocina, cocinero con IK de manos, pedidos, criaturas, rondas de taps, efectos épicos.
- **`web/`** – Panel de control y voz (`panel.html`) y el juego web original (cinchada de héroes vs villanos).
- **`config/`** – Todo lo ajustable sin tocar código (personajes y voces, frases del bot, rarezas, regalos).
- **`lanzadores/`** y **`scripts/`** – `.bat`/PowerShell para iniciar, detener y vigilar todo.

Más detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Inicio rápido (Windows)

Requisitos: Node.js 18+, Unity 6000.3 (URP) para compilar el juego, Microsoft Edge (voz), Windows 10/11.

```bash
cd bridge
npm install
copy .env.example .env      # y poné tu usuario de TikTok (sin @)
npm run mock                # prueba SIN live: genera regalos y comentarios falsos
npm start                   # modo real: se conecta al live de TIKTOK_USERNAME
```

1. Abrí el proyecto `unity-game/` con Unity 6000.3, bajá los modelos que indica [docs/ASSETS-Y-CREDITOS.md](docs/ASSETS-Y-CREDITOS.md) y compilá (`Build → Windows x64`).
2. Corré `lanzadores/INICIAR COCINA.bat` (servidor + panel + juego), escribí el `@usuario` en el menú, elegí cocinero y **COMENZAR**.
3. En tu software de transmisión (TikTok LIVE Studio/OBS) capturá **solo la ventana del juego** y el **audio de la computadora**: la voz del presentador sale por el panel.

Guía completa de operación, pruebas y problemas conocidos: [docs/OPERACION-LIVE.md](docs/OPERACION-LIVE.md). Configuración: [docs/CONFIGURACION.md](docs/CONFIGURACION.md).

## Seguridad y reglas de la plataforma

- Las claves van **solo** en `bridge/.env` (ignorado por git). Nunca se suben.
- Para recibir regalos reales TikTok exige requisitos de la cuenta (seguidores y edad); chat, taps y seguidores funcionan sin eso.
- Las automatizaciones que consultan a TikTok pueden ser limitadas o sancionadas. El puente espera entre reintentos y evita consultas repetidas, pero **cada usuario es responsable de cumplir las reglas de TikTok** y los derechos de autor de los personajes que use.

## Estado del proyecto

Funciona de punta a punta con eventos simulados y se probó con un live real. Quedan pendientes conocidos (ver [docs/OPERACION-LIVE.md](docs/OPERACION-LIVE.md#problemas-conocidos)): validar el flujo completo con audiencia real sostenida, y la integración de más cocineros y modelos.
