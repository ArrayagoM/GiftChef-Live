# Assets de terceros y créditos

Este repositorio **no incluye** modelos 3D, sonidos ni texturas de terceros. Se bajan aparte y se colocan en `unity-game/Assets/` (carpetas ignoradas por git). La escena `Cocina.unity` hace referencia a ellos; sin ellos Unity mostrará referencias vacías hasta que los agregues.

## Marcas y derechos

El proyecto es de fans y no está afiliado ni respaldado por TikTok, Nintendo/The Pokémon Company, Bird Studio/Toei Animation, ni sus titulares. Los nombres de personajes y criaturas son marcas de sus dueños. **Usar personajes protegidos en un live público puede violar los derechos de autor y las reglas de TikTok.** Para publicar o monetizar, reemplazalos por personajes propios o con licencia.

## Dónde van

| Carpeta | Contenido | Origen |
|---|---|---|
| `Assets/Modelos/Personajes/<id>/` | Cocineros humanoides (FBX con rig Humanoid) | Modelos propios/convertidos con Blender (`glb → fbx`) |
| `Assets/Modelos/Pokemon/<id>/` | Criaturas (`.glb`/`.gltf`, importadas con glTFast) | Sketchfab (abajo) |
| `Assets/Modelos/Cocina/` | Horno, freidora, objetos de cocina | Sketchfab / 3D Warehouse |
| `Assets/Resources/*.mp3` | Sonidos de mascota | Provistos por el usuario |

Importar `.glb` en Unity requiere el paquete **glTFast** (ya declarado en `Packages/manifest.json`).

## Modelos descargados de Sketchfab (licencia CC BY 4.0, salvo que cada página indique otra)

Se requiere **atribución** al autor. Revisá la licencia vigente en cada página antes de publicar.

| Modelo | Autor | Enlace (ID de Sketchfab) |
|---|---|---|
| Charizard Flying Animation | ryad_raba | `cf5a229a8ce34ff2b7c3f92426c5709b` |
| Dragonite (Official) | Mariokart07 | `874c7fcdbd344c7bb9e8ed3e6a04dfac` |
| Lugia (Official) | Mariokart07 | `95fcd59551404286925dd9d05fd3b9d5` |
| Garchomp | – | `dcb3101f15bb409d88c154e33dbcb118` |
| Greninja (Official) | – | `812359f8004644459ba50f309a6265ef` |
| Ho-Oh | – | `752d7f162e2d4445b5151352e75967c6` |
| Pokedex 3D Pro Umbreon | seth the yutyrannus | `8fda51cf8e664142ae6f037b68993fcb` |
| Mimikkyu Pokemon! | Lizzy Koopa | `37fdd54adb234339befa45cd6308252d` |
| Giratina | – | `9cb181a7b6ff4c9cb94e5757315f2806` |
| Kyogre | – | `265b2838b1824ec599274cef63a5b906` |
| Reshiram | – | `d4736ce401024480a600d878907e5755` |
| Pokemon 3D Pro Zekrom | JackTheOhio | `86f39bb7a74741dfb2cb4d5eeb8477b4` |
| Dialga | – | `26d1d95c7f814f85bdf875dede8abd00` |
| Xerneas | – | `f5c5ca9c2353452bb92209480425d392` |
| Yveltal | – | `0acfe57e09d240e7bd4ebf0ca56e6a63` |
| Entei | nguyenlouis32 | `1b55e956670f4fa9b4f5c784ff71a540` |
| Kitchen Utensil Rail | Crafted by jerovdl | `6055149eab00462ba31af1578c17826b` |
| Fire Extinguisher | yadavdk | `5676b179b3b744c0aaae53a3dcea2300` |
| Kitchen Knives Block | – | `838c5fbd4ec34f23abae67d89c91f8a0` |
| Plastic round bin | Sousinho | `cf7c9f627f344138a291a431c42beaae` |

**Pendiente:** las primeras criaturas del proyecto (Pikachu, Bulbasaur, Eevee, Snorlax, Psyduck, Meowth, Gengar, Zapdos, Mewtwo, Arceus) y los cocineros convertidos no están en esta tabla porque no guardé su fuente; anotalos acá antes de publicar el juego compilado.

Enlace de cada modelo: `https://sketchfab.com/3d-models/<ID>`. Donde el autor figura como "–" hay que completarlo al descargar. **Esta lista es de elaboración propia: verificá autor y licencia en cada página.**

## Incluido en el repositorio

- `web/assets/models/robot.glb` – *RobotExpressive*, Tomás Laulhe (mods de Don McCurdy), **CC0**.
- Texturas del bajo mesada, mármol y madera: generadas por código (sin archivos externos).
- Efectos épicos (`EpicFx`, shader `EpicAdditive`): generados por código.
