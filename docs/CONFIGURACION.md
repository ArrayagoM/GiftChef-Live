# Configuración

Todo lo que se puede cambiar sin tocar código está en `config/` y en `bridge/.env`.

## `bridge/.env`

| Variable | Para qué |
|---|---|
| `TIKTOK_USERNAME` | Usuario del live (sin `@`). El juego también puede cambiarlo desde su menú |
| `WS_PORT` | Puerto del WebSocket (por defecto 8080) |
| `GROQ_API_KEY` | (Opcional) IA del presentador con Groq |
| `ANTHROPIC_API_KEY` | (Opcional) IA con Claude (`"provider": "anthropic"` en `bot.json`) |

> El `.env` está en `.gitignore`. Si una clave se llega a subir por error, **revocala** en el sitio del proveedor.

## `config/bot.json` (presentador)

- `ai`: `enabled`, `provider` (`groq`/`anthropic`), `groqModel`, `maxRepliesPerMinute`, `minSecondsBetween`.
- `promoEverySec`, `greetJoinsEverySec`, `thankLikesEverySec`, `maxQueued`: ritmo del bot.
- `crowd`: umbrales para pasar a modo "mucha gente" (el bot habla menos y agrupa).
- `phrases`, `chatReplies`, `blockedWords`: frases y reglas del chat.

## `config/characters.json` (cocineros)

Cada personaje: `id`, `name`, `enabled`, `persona` (carácter, usado por la IA), `phrases` (frases propias) y `voice`:

```json
"voice": { "prefer": ["Jorge", "Tomas", "Dalia"], "pitch": 1.42, "rate": 1.12 }
```

`prefer` es la lista de voces neuronales de Microsoft por orden. `pitch` y `rate` se calibran en el panel (sección *Calibrar la voz*) y se guardan solos.

## `config/pokemon.json` (criaturas)

- `tiers`: por cada mínimo de diamantes, probabilidades `[común, raro, épico, legendario]`.
- `maxAlive`, `cooldown`, `maxLegend`, `legendCooldown`, `stay*`: cuántas a la vez y cuánto se quedan.
- `comboWindow`, `comboMin`, `comboChance`: regalos acumulados que pueden convocar un legendario.

Las criaturas disponibles se definen en la escena de Unity (componente `PokemonSpawner`): id, nombre, rareza, modelo, altura, giro y clip de animación.

## `config/gifts.json`, `race.json`, `brand.json`, `commands.json`

Pertenecen al juego web original (cinchada) y a la marca mostrada en pantalla. `brand.json` define nombre, usuario y color del sello.

## Dentro de Unity

- `GoalHud`: `eventEvery` (segundos entre eventos especiales), metas en `GoalFor()`.
- `KitchenController`: `maxQueued`, tiempos de cocción, estaciones.
- `StartMenu.options`: lista de cocineros (prefab, altura, giro).
