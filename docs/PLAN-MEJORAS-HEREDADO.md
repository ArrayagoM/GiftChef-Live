# Plan de mejoras: de "juego de TikTok" a producto con identidad TinTech

Basado en cómo trabajan los juegos grandes (la técnica se llama *game feel* o "juice"):
cada golpe combina **varios canales a la vez** (chispas + congelado + zoom + temblor + sonido),
con **intensidades proporcionales** (chico / medio / grande) y sin tapar lo que pasa en el juego.
Fuente de las técnicas: guías de game feel (hit-stop de 50-100 ms, shake corto, squash & stretch, partículas, sonido con variación de tono).

## Etapa 1 — HECHA
| Mejora | Detalle |
|---|---|
| Robots 3D animados | Modelo CC0 "RobotExpressive" (Tomás Laulhé). Corren, golpean, festejan. Azul = Héroes, rojo y ceñudo = Villanos. |
| Banco de robots | Se crean al arrancar y se reutilizan: cero tirones al llegar ráfagas. Máximo 8 robots completos a la vez. |
| Efectos de impacto | Chispas, congelado de 40-90 ms en golpes fuertes, tirón del zoom, estela de la pelota, números flotantes "+N". |
| Viñeteado | Bordes oscuros suaves, aspecto de película. |
| Marca TinTech | Presentación animada al arrancar, sello ⚡ TinTech @tinchotech permanente, firma en la pantalla de campeones, "T" en la pelota, Nova habla de tu canal. Todo editable en `config/brand.json`. |
| Rendimiento | Verificado en GTX 1650: ~131-136 FPS, 5 % más lento = 7 ms, 0 errores y memoria estable en prueba de resistencia. |

## Etapa 2 — propuesta (mayor impacto visual)
1. **Variedad de personajes por regalo:** un segundo y tercer modelo CC0 (ej. paquetes de Quaternius, hay que convertir de FBX a GLB) para que cada regalo grande tenga "su" personaje, como en el juego de referencia (Goku, Messi...).
2. **Arenas por ronda:** cambiar el escenario cada ronda (nieve, desierto, lava, espacio) con cielo, luz y música distintos. Mantiene el juego fresco en lives largos.
3. **Brillo (bloom) y corrección de color** con post-procesado de three.js. Cuesta rendimiento: se activaría solo si la PC lo aguanta (calidad adaptativa ya existente).
4. **Cámara de victoria cinematográfica:** giro lento alrededor del equipo ganador con cámara lenta.
5. **Panel de "Top donadores"** con fotos de perfil, como en los juegos de la competencia.

## Etapa 3 — propuesta (audio y retención)
1. **Sonidos reales** (packs CC0 de Kenney) en capas, con variación de tono para que no suene repetido.
2. **Combos y rachas visibles:** medidor que sube cuando muchos empujan seguidos.
3. **Misiones del live** ("llegar a 500 likes = lluvia de confeti") para dar objetivos al chat.

## Reglas para no romper nada
- Cada cambio se mide antes y después (FPS, tirones, memoria) con la prueba automática.
- Todo lo nuevo debe poder apagarse desde `config/`.
- Solo se usan modelos y sonidos con licencia CC0 o propia; cada archivo lleva su crédito en `web/assets/`.
