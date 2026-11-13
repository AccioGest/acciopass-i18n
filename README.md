# acciopass-i18n

Los textos de **AccioPass** —los de la aplicación y los que la API dice a una persona— viven aquí, en ficheros JSON ordenados por idioma. [Crowdin](https://crowdin.com) se sincroniza con este repositorio para que las traducciones se hagan y se aprueben allí, y la API recoge los cambios sola: **un texto corregido llega a la aplicación en segundos o, como mucho, en unos minutos, sin desplegar la API ni publicar una versión nueva de la app.**

- Aplicación: [AccioGest/acciopass-frontend](https://github.com/AccioGest/acciopass-frontend)
- API: [AccioGest/acciopass-backend](https://github.com/AccioGest/acciopass-backend)

## Índice

1. [Cómo funciona de principio a fin](#cómo-funciona-de-principio-a-fin)
2. [Qué hay en el repositorio](#qué-hay-en-el-repositorio)
3. [Formato de los mensajes](#formato-de-los-mensajes)
4. [Reglas de validación](#reglas-de-validación)
5. [El validador](#el-validador)
6. [Tareas habituales](#tareas-habituales): corregir un texto, añadir, borrar o renombrar una clave, añadir un espacio de nombres o un idioma
7. [Normas para quien traduce](#normas-para-quien-traduce)
8. [Modelo de seguridad](#modelo-de-seguridad) y [textos protegidos](#textos-protegidos)
9. [Puesta en marcha de Crowdin](#puesta-en-marcha-de-crowdin) (pasos manuales)
10. [Puesta en marcha de GitHub](#puesta-en-marcha-de-github) (protección de rama y webhook)
11. [Límites conocidos](#límites-conocidos)

## Cómo funciona de principio a fin

```
  Personas que traducen y revisan
               │
            Crowdin  ── solo exporta lo aprobado ──┐
               ▲                                    ▼
   lee locales/es/**            petición de cambios desde la rama l10n_main
               │                                    │
        ┌──────┴────────────────────────────────────▼──────┐
        │  GitHub: AccioGest/acciopass-i18n (rama main)     │
        │  validación automática + revisión de una persona  │
        └──────┬────────────────────────────────────────────┘
               │ webhook «push» (inmediato) + sondeo cada 5 minutos
               ▼
         API de AccioPass  ── valida otra vez y cambia el catálogo en memoria
               │
               │ GET /v1/i18n, GET /v1/i18n/app/{idioma}, evento «i18n.updated»
               ▼
           Aplicación  ── valida otra vez, mensaje a mensaje, y repinta
```

1. **El español es la fuente.** Los textos originales están en `locales/es/`. Se cambian con una petición de cambios (*pull request*) en este repositorio, como cualquier código.
2. **Crowdin lee la fuente** de la rama `main` y ofrece cada texto a quienes traducen. No hace falta subirle nada a mano.
3. **Crowdin devuelve las traducciones aprobadas** en una rama de servicio (`l10n_main`) y abre una petición de cambios hacia `main`.
4. **La petición se valida sola** (flujo `validar` de GitHub Actions) y **una persona del equipo la revisa y la fusiona.** Nada llega a `main` sin esas dos cosas.
5. **La API se entera** por el webhook de GitHub (en segundos) o, si el aviso se pierde o no está configurado, por su sondeo periódico (cada 5 minutos por defecto, `I18N_REFRESH_SECONDS`). Descarga esa versión, **la vuelve a validar entera** y, solo si es correcta, sustituye su catálogo en memoria. Si algo falla, sigue sirviendo el último catálogo bueno.
6. **La aplicación pregunta a la API**, nunca a GitHub ni a Crowdin. Lo hace al arrancar, al volver a primer plano, cada 5 minutos y cuando la API le avisa de que hay versión nueva. Valida cada mensaje por separado contra los textos que lleva dentro y descarta el que no cumpla.
7. **Siempre hay un texto que mostrar.** La aplicación y la API llevan dentro una copia de estos ficheros tomada al compilar. Sin red, o con este repositorio caído, se usa la última versión recibida y, si no la hay, esa copia.

**Cuánto tarda**, desde que se fusiona en `main`:

| Quién | Con webhook | Sin webhook (o si se pierde) |
| --- | --- | --- |
| La instancia de la API que recibe el aviso | segundos | hasta 5 minutos |
| Las demás instancias de la API | segundos si comparten el bus de eventos (Redis): la que recibe el aviso se lo pasa; si no, hasta 5 minutos | hasta 5 minutos |
| Una aplicación abierta y con sesión | segundos después que su API (evento `i18n.updated`) | igual |
| Una aplicación abierta sin sesión | hasta 5 minutos después que la API (y algún minuto más si hay una caché delante: las respuestas se pueden guardar 60 s) | igual |
| Una aplicación cerrada | al abrirla o al volver a primer plano | igual |

Esto vale para los textos que viajan en vivo, que son casi todos. Los [textos protegidos](#textos-protegidos) —los correos, la confirmación de inicios de sesión, lo que rodea a la contraseña maestra— **no**: cambian aquí igual, pero llegan a las personas con la siguiente versión de la API o de la aplicación.

Antes de eso está el tiempo de las personas: Crowdin sincroniza con GitHub cada hora por defecto y la petición de cambios espera a que alguien la revise.

**Si algo falla:** con GitHub caído o inalcanzable, la API sigue sirviendo el último catálogo bueno (lo guarda en disco, así que también tras reiniciarse) y vuelve a intentarlo en el siguiente intervalo; si nunca llegó a descargar ninguno, sirve la copia de su compilación. Con la API caída o sin conexión, la aplicación usa lo último que recibió y, si no recibió nada, los textos de su compilación. Un cambio que no pasa la validación no llega a nadie: se sigue viendo el texto anterior.

El orden en que se busca un texto es: traducción recibida en el idioma de la persona → traducción incluida en la compilación → español recibido → español incluido en la compilación. **Un texto sin traducir se muestra en español; nunca queda un hueco.** Para un texto protegido solo cuentan los dos pasos «incluido en la compilación».

## Qué hay en el repositorio

```
i18n.config.json              formato, idioma fuente y proyectos
crowdin.yml                   qué ficheros lee Crowdin y dónde escribe las traducciones
locales/
  es/                         idioma fuente: el único completo por definición
    locale.json               cómo se llama el idioma en el selector
    app/<espacio>.json        textos de la aplicación, un fichero por funcionalidad
    api/<espacio>.json        textos de la API: correos, notificaciones, errores, asistente
  en/                         una carpeta por idioma, con la misma estructura
    ...
scripts/validate.mjs          el validador (biblioteca y línea de órdenes)
scripts/validate.test.mjs     sus pruebas
scripts/check-l10n-pr.mjs     guarda de las peticiones de Crowdin: solo pueden tocar traducciones
fixtures/validation-cases.json   casos de validación compartidos con la API y la aplicación
.github/workflows/validate.yml   lo ejecuta en main y en cada petición de cambios
```

- **Los idiomas no se listan en ningún sitio: se descubren por las carpetas** de `locales/`. El nombre de la carpeta es el código del idioma en minúsculas, con región opcional en mayúsculas: `en`, `fr`, `pt-BR`. Expresión exacta: `^[a-z]{2,3}(-[A-Z]{2})?$`.
- **Proyectos**: `app` (lo que pinta la aplicación) y `api` (lo que la API dice a una persona). Están declarados en `i18n.config.json`.
- **Espacio de nombres** (*namespace*): cada fichero `.json`. La clave completa de un mensaje es `<espacio>.<ruta con puntos>`; por ejemplo, `actions.save` dentro de `locales/es/app/common.json` es `common.actions.save`.
- **`locale.json`** contiene solo `{ "name": "Español", "englishName": "Spanish" }`: el nombre del idioma en su propia lengua y en inglés. Lo escribe una persona del equipo y **no se envía a Crowdin**. Es además **el interruptor de publicación** de un idioma: sin él, sus textos se validan pero ni la API ni la aplicación lo ofrecen.
- Los **documentos legales** (Aviso Legal, Privacidad, Términos) no están aquí: siguen en sus repositorios, versionados junto al mecanismo de consentimiento. Sí están aquí los rótulos de la interfaz que los rodean.

## Formato de los mensajes

Objetos JSON anidados cuyas hojas son textos.

```json
{
  "actions": {
    "save": "Guardar"
  },
  "greeting": "Hola, {name}",
  "items": {
    "zero": "Sin elementos",
    "one": "{count} elemento",
    "other": "{count} elementos"
  }
}
```

- **Marcadores**: `{nombre}`, con llaves simples; el nombre solo admite letras sin acento, cifras y `_`. El programa los sustituye por un valor.
- **Plurales**: un objeto cuyas claves son `one` y `other` (obligatorias) y, si se quiere, `zero`. `one` se usa cuando la cantidad es exactamente 1, `zero` cuando es 0 (si existe) y `other` en los demás casos. Un plural siempre dispone de `{count}`.
- **Solo texto plano.** Ni HTML, ni Markdown, ni sintaxis ICU (`{count, plural, ...}`): nada de eso se interpreta; se vería tal cual.
- **Formato del fichero**: UTF-8 sin BOM, sangría de 2 espacios, salto de línea final y caracteres no ASCII escritos tal cual (`"ñ"`, no `"\u00f1"`). Es exactamente lo que produce `JSON.stringify(valor, null, 2)` más un salto de línea.
- **Orden de las claves**: el del fichero en español. Es el orden de referencia y no se reordena.
- **Claves**: letras sin acento, cifras, `_` y `-`; nunca un punto. Están prohibidos, como clave y como nombre de fichero, los nombres que todo objeto de JavaScript ya tiene: `__proto__`, `constructor`, `prototype`, `toString`, `toLocaleString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable` y los `__defineGetter__` y compañía. No es una manía: un grupo llamado `hasOwnProperty` llegó a tumbar la API entera.

## Reglas de validación

Son las mismas en tres sitios: aquí (antes de fusionar), en la API (al descargar) y en la aplicación (al recibir). Un paquete de textos que no las cumple se rechaza: aquí no se puede fusionar, y la API se queda con el catálogo que tenía. La aplicación, que es la última barrera, descarta solo el mensaje que falla y usa los demás.

Que los tres sitios dicen lo mismo no se da por supuesto: [`fixtures/validation-cases.json`](fixtures/validation-cases.json) reúne mensajes y repositorios enteros, hostiles y legítimos, con el veredicto esperado de cada uno, y los tres repositorios ejecutan ese mismo fichero en sus pruebas (ver «El validador»).

**Para cada mensaje de un idioma que no es la fuente:**

| Regla | Ejemplo que se rechaza |
| --- | --- |
| La clave tiene que existir en español. | Añadir `auth.login.extra` solo en inglés. |
| El tipo tiene que coincidir: texto con texto, plural con plural. | Traducir un plural con un texto simple. |
| Los marcadores tienen que ser un subconjunto de los del original: se puede prescindir de uno, **nunca inventar otro**. | Original `Hola, {name}`; traducción `Hello, {user}`. |
| Un plural necesita `one` y `other`, y ninguna forma más que `zero`. | `{ "one": "1 item" }` |

**Para cada mensaje de cualquier idioma, incluido el español:**

| Regla | Detalle |
| --- | --- |
| Texto plano. | Se rechaza `<` seguido de una letra o de `/` (`<b>`, `</a>`, `<script>`). `a < b` es válido. |
| Sin caracteres de control. | Solo se admite el salto de línea. Ni tabuladores ni retornos de carro. |
| Sin controles bidireccionales. | Marcas, incrustaciones, inversiones y aislamientos (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069): cambian el orden en que se lee un texto («evorppa» que se ve «approve»). |
| Sin caracteres invisibles o en blanco. | Espacio de anchura cero, separadores de línea y de párrafo (U+2028, U+2029), guion opcional, unidor de palabras, rellenos de hangul, braille en blanco, BOM, caracteres de etiqueta… Un texto tiene que verse. Los unidores de anchura cero (U+200C, U+200D) y los selectores de variación sí se admiten **dentro** de un texto (los necesitan el persa, las escrituras índicas y los emojis), pero un texto hecho solo de ellos cuenta como vacío. |
| Longitud. | Máximo 4000 caracteres, y una traducción como mucho el mayor de: 3 veces el original, o el original más 200. |

**Para cada traducción, además: nada adonde ir ni a quien escribir que el original no tenga.** Se rechaza cualquier cosa que una persona, un cliente de correo o un teléfono tomarían por una dirección o un contacto, salvo que **esa misma, carácter a carácter,** esté en el mensaje original:

| Qué | Ejemplos que se rechazan |
| --- | --- |
| Direcciones con cualquier esquema | `https://…`, `http://…`, `ftp://…`, `intent://…`, `otpauth://…` |
| Esquemas que funcionan sin `//` | `mailto:`, `tel:`, `sms:`, `javascript:`, `data:`, `file:`… |
| Direcciones sin esquema | `//dominio/ruta`, `www.dominio.com` |
| Dominios sueltos | `acciopass-login.com/unlock`, también dentro de un enlace Markdown `[texto](dominio.com)` |
| Direcciones de correo | `seguridad@otro-dominio.com` |
| Direcciones IP | `10.0.0.1/login` |
| Números de siete o más cifras | teléfonos: `900 123 456`, `+1 (900) 123-45-67` |

La búsqueda se hace sobre el texto **normalizado** (NFKC, sin unidores de anchura cero), así que no sirve escribir la dirección con letras de ancho completo, con un punto ideográfico (`evil。example`) o con un carácter invisible en medio. Dos excepciones, las únicas: los dominios reservados para ejemplos, que no son de nadie (`example.com`, `example.org`, `example.net` y un correo en ellos: `nombre@example.com`), y el teléfono del original con un prefijo internacional de hasta tres cifras delante (`950 674 456` → `+34 950 674 456`).

Lo que **no** se toma por dirección: decimales y versiones (`3.5 mm`, `1.2`), horas (`10:30`), abreviaturas de una letra (`a.m.`, `i.e.`), `y/o`, y el punto ideográfico entre dos frases en chino o japonés. Sí se toma, y habrá que escribirlo con un espacio, una palabra pegada a la siguiente por un punto (`fin.Otra frase`): se lee como un dominio.

**Qué no es un error:**

- **Que falte una clave** en un idioma que no es la fuente: se muestra en español. El validador informa de cuánto está traducido cada idioma.
- **Una traducción vacía (`""`, o solo espacios)**: cuenta como «sin traducir» y se muestra en español. Es la forma en que Crowdin exporta, en JSON anidado, un texto que nadie ha traducido o aprobado todavía. Un plural con `one` u `other` vacíos se ignora entero, con un aviso, hasta que esté completo.
- **Un idioma sin publicar**: una carpeta de idioma sin `locale.json`, o con él pero sin ningún texto de la aplicación traducido y válido. Sus ficheros **se validan igual** (un texto inválido en ellos es un error y bloquea), pero el idioma no se ofrece: la API no lo lista ni lo sirve, y no aparece en el selector de las aplicaciones. El validador lo dice con un aviso (`locale-unpublished`, `locale-empty`) y lo marca «(sin publicar)» en la tabla.

**Qué es un error en este repositorio y solo se ignora (dejando constancia en el registro) en la API y en la aplicación:** ficheros o carpetas desconocidos y espacios de nombres que no existen en español.

Además, este validador comprueba cosas que solo tienen sentido sobre ficheros: JSON válido, UTF-8 sin BOM, **claves repetidas en un mismo objeto** (un analizador JSON se queda en silencio con la última, así que una repetición podría esconder un texto a quien revisa), tamaño máximo de 1 MB por fichero, enlaces simbólicos, nombres de carpeta de idioma, `locale.json` bien formado (y presente en el idioma fuente), y el formato canónico (error en español; en los demás idiomas, que escribe Crowdin, **un solo aviso por idioma** con el número de ficheros).

Y emite **avisos** que no bloquean pero piden una mirada humana: texto con aspecto de sintaxis ICU (`icu-syntax`), plural a medio traducir (`plural-incomplete`), un `one` que ha perdido el `{count}` que el original sí lleva (`plural-one-without-count`: `one` se usa solo para exactamente 1, pero conviene comprobar que la frase lo dice), e idioma sin publicar.

## El validador

Hace falta Node.js 22 o posterior. No tiene dependencias: no hay nada que instalar.

```sh
npm run validate                    # valida este repositorio
node scripts/validate.mjs <carpeta> # valida otra copia
node scripts/validate.mjs --json    # salida para máquinas
npm test                            # pruebas del validador y de la guarda de Crowdin
git diff --name-only --no-renames -z main...l10n_main | npm run -s check:l10n   # lo que hace la guarda en una petición de Crowdin
```

Código de salida: `0` sin errores, `1` con errores, `2` si la orden está mal escrita. El informe lista cada error con su fichero, su clave y un código estable entre corchetes, y termina con una tabla de completitud por idioma y proyecto.

`scripts/validate.mjs` es un único fichero pensado para copiarse tal cual a los otros repositorios. Como biblioteca exporta, entre otras:

| Función | Para qué |
| --- | --- |
| `loadLocalesTree(carpeta)` | Lee `i18n.config.json` y `locales/**`. No lanza excepciones por el contenido: los problemas quedan en `tree.problems`. |
| `validateTree(árbol)` | Valida un árbol (leído de disco o construido en memoria). Devuelve `ok`, `errors`, `warnings`, la completitud por idioma y `messages`: solo los mensajes que han pasado. |
| `validateMessage(original, traducción)` | Valida **un** mensaje. Devuelve `ok`, `untranslated` o `invalid`. Es la pieza para validar mensaje a mensaje. |
| `computeCompleteness(árbol)` | `{ idioma: { proyecto: { translated, total, ratio } } }`. |
| `validateDirectory(carpeta)` | Las dos primeras en una llamada. |

### Los casos compartidos

`fixtures/validation-cases.json` es la definición ejecutable de las reglas. Tiene tres listas y, aparte, `protectedKeys` (ver [textos protegidos](#textos-protegidos)):

- `messages`: un original, una traducción candidata y el veredicto (`ok` con el valor que se usa, `untranslated` o `invalid`);
- `sourceMessages`: lo mismo para un mensaje del idioma fuente;
- `bundles`: repositorios enteros (los ficheros de `base` con los de cada caso encima) con estas expectativas: qué dice este validador (`validator`), si una API en marcha acepta el lote o se queda con el que tenía (`api`), qué idiomas ofrece después (`locales`) y qué claves de la aplicación sobreviven mensaje a mensaje (`messages`).

`npm test` lo ejecuta aquí contra `scripts/validate.mjs`. La API y la aplicación guardan una copia (`i18n/validation-cases.json` en cada repositorio), que su `npm run i18n:sync` refresca, y la ejecutan contra su propia implementación; ninguna prueba lee fuera de su repositorio. **De este repositorio los otros dos solo copian datos** —los `.json` de `locales/` y ese fichero de casos—, nunca código: `scripts/validate.mjs` no se copia ni se ejecuta en ellos. Este es el repositorio más expuesto a contribuciones externas; nada de lo que hay aquí debe poder ejecutarse en la máquina de quien desarrolla la API o la aplicación. **Para cambiar una regla:** se cambia aquí el validador y el caso que la fija, y después, en cada uno de los otros dos repositorios, `npm run i18n:sync -- <este repositorio>` trae el fichero nuevo y sus pruebas fallan hasta que su implementación dice lo mismo.

## Tareas habituales

### Corregir un texto en español

1. Edita el fichero de `locales/es/` en una rama y abre una petición de cambios.
2. Cuando se fusione, la API lo servirá en segundos (webhook) o en pocos minutos (sondeo). Si es un [texto protegido](#textos-protegidos), llegará con la siguiente versión de la API o de la aplicación (`npm run i18n:sync` en su repositorio).
3. Crowdin verá el cambio en su siguiente sincronización. La traducción anterior de ese texto se conserva, pero **pierde la aprobación** (`update_option: update_as_unapproved` en `crowdin.yml`), así que deja de exportarse (pasa a `""`) hasta que alguien la revise. Es intencionado: una traducción aprobada para un original que ya no existe no es una traducción aprobada. **Qué se ve mientras tanto** depende de dónde:
   - en un idioma que solo existe en vivo, y en los textos que escribe la API: el texto en **español**;
   - en un idioma que la aplicación lleva dentro (hoy, el inglés): la **traducción anterior**, la que iba en la compilación, porque la aplicación busca primero en lo recibido (donde ya no está) y después en lo compilado (donde sigue). Deja de verse cuando se apruebe la nueva o cuando se publique una versión de la aplicación sincronizada después del cambio.

### Corregir una traducción

En Crowdin: se corrige y **se aprueba**. Llegará en la siguiente petición de cambios de `l10n_main`. No edites a mano los ficheros de un idioma traducido en `main`: Crowdin podría sobrescribir el cambio en su siguiente exportación.

### Añadir una clave

Añadir una clave que ningún programa usa no cambia nada: una clave nueva va siempre de la mano de un cambio de código.

1. Añádela en `locales/es/<proyecto>/<espacio>.json`, en el lugar que le corresponda (el orden importa: es el de referencia), y fusiónalo aquí. **Basta el español.** No hace falta —ni conviene— escribir a mano la traducción en los demás idiomas: llegará por Crowdin.
2. En el repositorio que la vaya a usar, ejecuta `npm run i18n:sync -- <ruta o URL de este repositorio>` para regenerar los textos incluidos en la compilación (y, en la aplicación, los tipos de `t()`), y úsala en el código. La sincronización **no exige que el inglés esté completo**: lo que aún no tiene traducción aprobada se queda fuera de la copia y se ve en español hasta que llegue.
3. Hasta que esa versión de la aplicación o de la API esté publicada, la clave nueva viaja pero nadie la pide. Las versiones antiguas la ignoran.

**No cambies el significado de una clave existente ni le añadas marcadores**: las aplicaciones ya instaladas la seguirán pidiendo con los parámetros antiguos. Para un texto con otro significado u otros marcadores, crea una clave nueva.

### Borrar o renombrar una clave

Una traducción de una clave que ya no existe en español es un error (`unknown-key`): impide fusionar y, si llegara a `main`, la API rechazaría el lote entero. Por eso borrar tiene su orden:

1. **Comprueba que ninguna versión en uso la pide.** Una aplicación instalada que la pida mostrará el texto que lleva dentro, así que no se rompe nada; pero ese texto ya no se podrá corregir en vivo.
2. **En la misma petición de cambios, borra la clave de `locales/es/` y de todos los demás idiomas.** Es la única edición a mano de ficheros traducidos que este proceso admite (borrar, nunca escribir). `npm run validate` te dirá cuáles faltan.
3. **Mira si hay una petición de Crowdin abierta** (`l10n_main`). Se exportó antes del borrado y volvería a traer la clave: espera a que Crowdin la actualice después de leer el `main` nuevo (lo hace en su siguiente sincronización), o ciérrala y deja que la abra de nuevo. Si su validación falla por `unknown-key`, es esto.

**Renombrar es añadir y, más adelante, borrar.** Crea la clave nueva, publica la versión del programa que la usa y borra la antigua cuando ya nadie la pida. Para Crowdin la clave nueva es un texto nuevo: su traducción hay que volver a aprobarla (la memoria de traducción de Crowdin la propone sola); mientras tanto se ve en español.

### Añadir un espacio de nombres

1. Crea `locales/es/<proyecto>/<nuevo>.json` (el nombre empieza por letra y solo lleva letras, cifras, `_` o `-`).
2. No hay que tocar `crowdin.yml`: recoge todos los `.json` de cada proyecto.
3. Sigue los pasos de «Añadir una clave» en el repositorio que lo use.

Un **proyecto** nuevo (una tercera carpeta junto a `app` y `api`) sí exige declararlo en `i18n.config.json` y añadir su bloque en `crowdin.yml`; una prueba falla si se olvida.

### Añadir un idioma

Un idioma se **ofrece** —la API lo lista y lo sirve, y aparece en el selector de las aplicaciones ya instaladas— cuando tiene las dos cosas: su `locale.json` y al menos un texto de la aplicación traducido y válido. El orden da igual; mientras falte una, el idioma está «sin publicar» y no molesta a nadie.

1. **En Crowdin**: añade el idioma de destino al proyecto (*Settings > Languages*). **Si es una variante regional, lee antes el apartado siguiente.** En su próxima exportación Crowdin escribirá `locales/<código>/app/*.json` y `locales/<código>/api/*.json` con todos los valores vacíos; es normal y la validación lo acepta (el idioma sale como «sin publicar»).
2. **Aquí**, cuando decidas publicarlo: crea `locales/<código>/locale.json` con el nombre del idioma en su propia lengua y en inglés, y fusiónalo en `main` (este fichero no lo escribe Crowdin nunca: que un idioma aparezca en el selector de todas las aplicaciones es una decisión de una persona del equipo).

   ```json
   {
     "name": "Français",
     "englishName": "French"
   }
   ```

3. En cuanto haya `locale.json` **y** llegue por `l10n_main` la primera traducción aprobada de un texto de la aplicación, **el idioma aparece en el selector**, marcado como «(parcial)», con lo que esté traducido en ese idioma y el resto en español. Si prefieres que no aparezca hasta estar razonablemente completo, no fusiones `locale.json` hasta entonces: la tabla de `npm run validate` dice cuánto lleva.

Los [textos protegidos](#textos-protegidos) de un idioma nuevo no viajan en vivo: se verán en español hasta que una versión de la aplicación (o de la API, para los correos) lo incluya en su compilación.

**Idiomas con región** (`pt-BR`, `zh-CN`, `es-MX`). `crowdin.yml` usa el marcador `%two_letters_code%`, que para una variante regional da solo el código del idioma: `pt`, `zh`, `es`. Dos variantes del mismo idioma escribirían en la misma carpeta, y **una variante del español («Spanish, Mexico», «Spanish, Argentina»…) escribiría encima de `locales/es/`, que es la fuente de todo**: si esa petición se fusionara, el español de México pasaría a ser el original de todos los idiomas y Crowdin retiraría la aprobación de todas las traducciones.

Hay dos defensas, y aun así **no añadas nunca una variante regional en Crowdin sin mirar antes `crowdin.yml`**:

- `crowdin.yml` ya declara una carpeta propia (`languages_mapping`) para las variantes más probables: `es-MX`, `es-AR`, `es-US`, `en-GB`, `fr-CA`, `pt-BR`, `zh-CN` y `zh-TW`. Para cualquier otra, añádela **antes**, en **los dos** bloques de `files`:

  ```yaml
      languages_mapping:
        two_letters_code:
          pt-BR: pt-BR
          es-CO: es-CO
  ```

  La clave es el código del idioma en Crowdin y el valor, el nombre de la carpeta, que tiene que cumplir el patrón de este repositorio.
- El flujo `validar` ejecuta en las peticiones de Crowdin (ramas `l10n_*`) una guarda, `scripts/check-l10n-pr.mjs`, que **falla si la petición toca cualquier cosa que no sea `locales/<idioma que no es la fuente>/<proyecto>/<espacio>.json`**. Una petición que escriba en `locales/es/` no se puede fusionar.

El patrón de carpetas (`^[a-z]{2,3}(-[A-Z]{2})?$`) no admite variantes de escritura ni regiones numéricas (`zh-Hans`, `sr-Latn`, `es-419`): para esas hay que elegir en el `languages_mapping` un código de región equivalente (`zh-CN` para el chino simplificado, por ejemplo).

## Normas para quien traduce

1. **Conserva los marcadores tal cual**: `{name}`, `{count}`. No los traduzcas (`{nombre}` no funciona), no les añadas espacios y no inventes ninguno. Puedes cambiarlos de sitio y, si la frase no lo necesita, omitir alguno.
2. **Solo texto.** Nada de HTML (`<b>`), Markdown (`**negrita**`) ni enlaces.
3. **No añadas direcciones web.** Si el original lleva una, cópiala idéntica. Si crees que hace falta otra, coméntalo en Crowdin: no la escribas.
4. **Plurales**: cada plural aparece en Crowdin como dos o tres cadenas sueltas cuyo identificador acaba en `.one`, `.other` y, a veces, `.zero`. `one` se usa cuando la cantidad es **exactamente 1**; `other`, para todas las demás (**también 0, 21, 101…**); `zero`, si existe, cuando es 0. Traduce siempre `one` y `other` (con una sola, el plural entero se ignora). **Rellena `zero` si tu idioma trata el cero de otra manera que `other`** (en francés, «0 élément», en singular) o si queda mejor una frase propia («Sin elementos»). Si tu idioma necesita más formas de plural de las que hay, usa en `other` una redacción que sirva para todas las cantidades y avisa en un comentario.
5. **Si la traducción correcta es idéntica al original, guárdala idéntica y apruébala** (nombres propios y marcas como «Google» o «AccioPass», formatos como `XXXXX-XXXXX`, textos que son solo un marcador). Una cadena sin traducción aprobada se exporta vacía y se vería en español, que en estos casos da igual, pero el idioma nunca llegaría al 100 %.
6. **No escribas direcciones, correos ni teléfonos que el original no tenga**, ni siquiera sin `https://` (`ejemplo.com`): la validación los rechaza. Los del original se copian idénticos. Para una dirección de ejemplo usa `example.com`.
7. **No alargues mucho el texto**: tiene que caber en un botón o en una notificación. El límite técnico es tres veces el original (o el original más 200 caracteres).
8. **Nunca pidas datos a la persona en un texto que el original no los pida**, y nunca cambies dónde se le dice que escriba su contraseña maestra. AccioPass no puede leer la bóveda de nadie; un texto que diga lo contrario o que mande a alguien a otro sitio es exactamente lo que este proceso está diseñado para impedir.
9. Respeta el tono del original: cercano, de tú, sin tecnicismos. Los saltos de línea del original suelen ser intencionados. No uses caracteres invisibles ni marcas de dirección de escritura.
10. Si un texto original es ambiguo o tiene una errata, **no lo arregles en la traducción**: comenta la cadena en Crowdin para que se corrija en español.

**Estas normas tienen que estar donde las lee quien traduce**, que no es este fichero: cópialas en la descripción del proyecto de Crowdin (ver «Puesta en marcha de Crowdin») y añade a las cadenas de plural la nota de contexto «one = exactamente 1; other = 0, 2, 3…; zero, opcional, = 0».

Una traducción que incumpla las reglas técnicas no rompe nada: la validación la detiene y ese texto se sigue viendo como estaba. Pero bloquea la petición de cambios entera hasta que se corrija en Crowdin, así que conviene acertar a la primera.

## Modelo de seguridad

AccioPass es un gestor de contraseñas de **conocimiento cero**: ni el servidor ni el equipo pueden leer la bóveda de nadie, y todo depende de que la contraseña maestra no salga del dispositivo. Eso convierte los textos en una superficie de ataque. Quien consiga cambiar una traducción no necesita romper ningún cifrado: le basta con que la pantalla de inicio diga «por seguridad, confirma tu contraseña maestra en esta otra dirección». Y, a diferencia del código, **estos textos llegan a las aplicaciones ya instaladas sin pasar por una compilación ni por la revisión de una tienda de aplicaciones.**

Por eso todo texto que no venga dentro de la compilación se trata como una entrada que no es de fiar, y hay varias barreras independientes:

| Barrera | Qué impide |
| --- | --- |
| **Solo texto plano**: sin HTML, sin caracteres de control. | Que un texto se convierta en un enlace, una imagen, un formulario o un guion. Las aplicaciones, además, pintan los textos como texto y nunca los interpretan. |
| **Nada adonde ir ni a quien escribir que el original no tenga**: ni direcciones (con o sin esquema), ni dominios sueltos, ni correos, ni teléfonos. | La forma más directa de engaño: mandar a la persona a un sitio falso, o a escribir o llamar a quien no es. Los clientes de correo convierten en enlace cualquier cosa que parezca una dirección. Solo pasa lo que es idéntico a lo del original en español. |
| **Sin controles bidireccionales ni caracteres invisibles.** | Que un texto se lea distinto de como está escrito, que un aviso quede en blanco, o que una dirección se esconda de las reglas de arriba. |
| **Sin claves con nombre de propiedad de todo objeto** (`toString`, `hasOwnProperty`…). | Que un fichero de textos altere el comportamiento de los programas que lo leen. |
| **[Textos protegidos](#textos-protegidos)**: los más sensibles no se toman nunca de aquí en vivo. | Que una frase que miente, y que ninguna regla automática puede detectar, llegue en segundos a todas las aplicaciones. |
| **Los nombres de fichero que la aplicación entrega no son textos**: los pone el código. | Que un fichero con las palabras de recuperación se descargue como `.bat` o `.url`. |
| **Las peticiones de Crowdin solo pueden tocar traducciones** (guarda en el flujo `validar`). | Que Crowdin, por un error de configuración o una cuenta comprometida, cambie la fuente en español, el validador o el flujo. |
| **Sin marcadores inventados.** | Que una traducción haga aparecer en pantalla un dato que el original no mostraba. |
| **Claves y tipos tienen que existir en español.** | Colar textos nuevos por la puerta de las traducciones. Lo que se puede decir lo define la fuente, que solo cambia con una petición de cambios revisada. |
| **Límite de longitud.** | Esconder un párrafo de instrucciones dentro del rótulo de un botón, o tumbar la interfaz con textos enormes. |
| **Crowdin exporta solo lo aprobado.** | Que una sugerencia de cualquier colaborador llegue al repositorio sin que alguien de confianza la haya leído. |
| **Rama `main` protegida**: petición de cambios, validación obligatoria y aprobación de una persona. | Que Crowdin, o una cuenta comprometida, escriba directamente en lo que la API descarga. |
| **La API valida otra vez** todo lo que descarga y, ante cualquier fallo, conserva el catálogo anterior. | Que un error en este repositorio (o un repositorio manipulado) llegue a las aplicaciones. |
| **La aplicación valida otra vez**, mensaje a mensaje, contra los textos que lleva dentro. | Que una API mal configurada o un intermediario entreguen un texto dañino. Un mensaje malo se descarta sin afectar al resto. |
| **El webhook va firmado** (HMAC-SHA256 con un secreto compartido) y solo provoca que la API vuelva a mirar el repositorio. | Que cualquiera fuerce descargas o inyecte contenido: el aviso no transporta textos. |

**Lo que las reglas automáticas no pueden ver**, y por eso la aprobación en Crowdin y la revisión de la petición de cambios son imprescindibles: una frase sin enlaces ni marcado que simplemente miente («escribe tu contraseña maestra en el chat de soporte», «tu cuenta caduca hoy»). Ninguna expresión regular distingue eso de una traducción legítima. **Solo lo detiene una persona que lea el cambio**, y para los textos donde el daño sería mayor ni siquiera eso se considera bastante: son los textos protegidos del apartado siguiente. De ahí que:

- en Crowdin solo deban poder aprobar personas de confianza que dominen el idioma (ver más abajo quién);
- nadie deba fusionar una petición de `l10n_main` sin leer las diferencias, aunque la validación esté en verde;
- los cambios en `scripts/`, `.github/`, `crowdin.yml` e `i18n.config.json` merezcan la revisión más estricta: son los que podrían debilitar la validación misma. Una petición de cambios que venga de Crowdin **no tiene por qué tocar nada fuera de `locales/`**; si lo hace, no se fusiona.

Este repositorio es público y no contiene ni debe contener secretos: ni credenciales de Crowdin ni el secreto del webhook.

**Condición previa para que la API lea de aquí en producción** (`I18N_SOURCE=github`): la rama `main` protegida como se describe en «Puesta en marcha de GitHub» (petición de cambios, `validar` obligatoria, una aprobación, sin excepciones para administradores) y Crowdin exportando **solo traducciones aprobadas**. Sin esas dos cosas, una sola cuenta comprometida cambia en segundos lo que leen todas las aplicaciones abiertas.

### Textos protegidos

Hay textos en los que una sola frase basta para quitarle la cuenta a alguien: el botón que rechaza un inicio de sesión que no es tuyo, la pantalla que pide la contraseña maestra, el correo que avisa de un acceso nuevo. Para esos, la revisión humana de este repositorio no es la única barrera: **la aplicación y la API no los toman nunca del catálogo en vivo. Usan siempre los que llevan dentro de su compilación**, que se revisan como código y, en la aplicación, pasan además por las tiendas.

| Proyecto | Claves protegidas (por prefijo) | Qué son |
| --- | --- | --- |
| `app` | `approvals.` | Confirmar o rechazar un inicio de sesión desde otro dispositivo. |
| `app` | `auth.` | Acceso, alta, desbloqueo, contraseña maestra, palabras de recuperación y el contenido del fichero en que se guardan. |
| `app` | `accountSecurity.` | Verificación en dos pasos y sus códigos, dispositivos, sesiones, historial, cambio de contraseña y de correo. |
| `app` | `security.` | Avisos de contraseñas filtradas, débiles o repetidas. |
| `app` | `legal.`, `shell.legal.` | Consentimientos y lo que rodea a los documentos legales. |
| `app` | `shell.restricted.`, `shell.recoveryReminder.` | Cuenta restringida; recordatorio de las palabras de recuperación. |
| `app` | `settings.reauth.`, `settings.account.` | Volver a identificarse; la sección de cuenta, que incluye eliminarla. |
| `app` | `sharing.fingerprint.` | Comprobar con quién se comparte una contraseña. |
| `api` | `emails.` | **Todos** los correos: códigos, avisos de acceso, recuperación, cambios en la cuenta. |
| `api` | `push.loginApproval.` | La notificación que pide confirmar un inicio de sesión. |

Qué significa en la práctica:

- **Se editan y se traducen aquí como cualquier otro texto** (este repositorio sigue siendo su única fuente, y Crowdin los traduce igual), pero un cambio **no llega en vivo**: llega cuando el repositorio de la aplicación o de la API ejecuta `npm run i18n:sync` y publica una versión.
- **Un idioma que solo existe en vivo** (no incluido en la compilación; hoy lo están el español y el inglés) muestra estos textos en español, y sus correos llegan en español.
- **La lista es del código** de cada programa (`src/i18n/protected.ts` en los dos repositorios), no de este repositorio: si viviera aquí, quien pudiera cambiar un texto podría también quitarle la protección. `fixtures/validation-cases.json` lleva una copia (`protectedKeys`) y una prueba de cada repositorio compara la suya con ella, así que no se puede cambiar en un solo sitio sin que algo falle. Para proteger un prefijo más, o para dejar de proteger uno: se cambia en el código de quien corresponda y en ese fichero, en ese orden.

Lo demás —la navegación, la bóveda, los códigos, el generador, los ajustes, los mensajes de error, las respuestas del asistente— viaja en vivo.

## Puesta en marcha de Crowdin

Pasos manuales, una sola vez. Los nombres de los menús son los de la documentación de Crowdin en el momento de escribir esto ([integración con GitHub](https://support.crowdin.com/github-integration/), [fichero de configuración](https://support.crowdin.com/developer/configuration-file/), [ajustes de exportación](https://support.crowdin.com/project-settings/export/), [roles](https://support.crowdin.com/roles/)).

1. **Crea el proyecto.** De tipo basado en ficheros (*file-based*), con **idioma de origen «Spanish»** y, como idiomas de destino, al menos «English». Decide si es público o privado; si es público, cualquiera puede proponer traducciones (no aprobarlas). **Pega en la descripción del proyecto las «Normas para quien traduce»** de este fichero: es lo que ve quien entra a traducir.

2. **Ajusta la exportación** en *Settings > Export* del proyecto. Estas dos opciones **no se pueden declarar en `crowdin.yml`**; si no se marcan, el proceso no es seguro ni correcto:
   - **«Export only approved translations»**: marcada. Solo se exporta lo traducido **y aprobado**.
   - **«Skip untranslated strings»**: marcada. Por defecto Crowdin rellena lo no traducido con el texto de origen, y aquí eso haría pasar el español por traducción. Con la opción marcada, en JSON anidado Crowdin exporta la clave con valor vacío (`""`), que todo el sistema entiende como «sin traducir».
   - **«Skip untranslated files»**: sin marcar. Exige ficheros traducidos al 100 % y anula la opción anterior: un idioma a medias no llegaría nunca.

3. **Instala la integración de GitHub**: en el proyecto, *Integrations > GitHub > Set Up Integration*, modo **«Source and translation files mode»**. Crowdin se conecta a GitHub como una aplicación OAuth con los permisos de **la cuenta que la autoriza**, o con un token personal que le des; su documentación no describe una forma de limitarla a un repositorio desde esa pantalla. Para que solo alcance este repositorio, **autoriza la integración con una cuenta de GitHub dedicada** (un usuario de servicio) que solo tenga acceso de escritura a `AccioGest/acciopass-i18n`, o dale un **token detallado (*fine-grained*) limitado a este repositorio** con permisos de contenido, peticiones de cambios y webhooks (la documentación de Crowdin pide permiso de administración sobre el repositorio para crear el webhook). No la autorices con la cuenta de un administrador de la organización.

4. **Elige repositorio y rama**: repositorio `AccioGest/acciopass-i18n`, rama **`main`**. Crowdin creará la rama de servicio `l10n_main` (prefijo `l10n_` por defecto) y **enviará las traducciones con una petición de cambios**; no escribe directamente en `main`. No actives la sincronización automática de otras ramas.

5. **Opciones de sincronización** de la integración:
   - *Default configuration file name*: `crowdin.yml` (el valor por defecto).
   - *Import existing translations*: **«One-time translation import after the branch is connected»**, para que el inglés que ya existe en `locales/en/` entre en Crowdin la primera vez. **No** uses «Always import new translations from the repository»: las traducciones se hacen en Crowdin, no en el repositorio.
   - En *Upload translations options*, marca **las dos casillas** para esa primera importación:
     - **«Approve added translations»**: el inglés actual ya está revisado; si no, quedaría sin aprobar y dejaría de exportarse.
     - **«Allow target translation to match source»**: hoy hay 51 textos en inglés idénticos al español (`Google`, `Apple`, `GitHub`, `TOTP`, `AccioPass`, `IP {ip}`, `XXXXX-XXXXX`, `{count} bit`…). Sin esta casilla Crowdin no importa una traducción igual a su original; con «Skip untranslated strings» esos textos volverían vacíos en la primera petición de cambios y el inglés bajaría del 100 %. (La documentación de Crowdin no dice cuál es el valor por defecto de esta casilla: compruébala.)
   - *Push Sources*: **desactivado** (es el valor por defecto). La fuente en español solo cambia con peticiones de cambios en GitHub.
   - *Sync Schedule*: el intervalo por defecto (una hora) es razonable. Los cambios de la fuente en `main` los recoge Crowdin de forma continua con independencia de este ajuste.

6. **Quién puede aprobar.** En Crowdin aprueban los roles *Owner*, *Manager*, *Language Coordinator* (en sus idiomas) y *Proofreader*; el rol *Translator* propone y vota, pero **no aprueba**. Da *Proofreader* o *Language Coordinator* solo a personas de confianza que dominen el idioma, y *Manager* a las mínimas imprescindibles (un *Manager* puede cambiar los ajustes de exportación y la integración). Recomendación: que quien aprueba no sea quien tradujo.

7. **Comprueba el primer ciclo.** Tras la primera sincronización: los ficheros de `locales/es/app/` y `locales/es/api/` aparecen en Crowdin con su estructura de carpetas; `locale.json` **no** aparece; y la primera petición de cambios de `l10n_main` pasa el flujo `validar` (incluida la guarda «solo toca traducciones») y solo toca ficheros de `locales/<idioma>/`. Dos cosas que mirar en esa primera petición:
   - **que no convierta en `""` ningún texto en inglés que hoy existe** (en la pestaña de diferencias, ninguna línea de `locales/en/` debe pasar de un texto a `""`; la tabla de `npm run validate` debe seguir diciendo 100 % para `en`). Si lo hace, faltó marcar «Allow target translation to match source» o «Approve added translations»: corrígelo en Crowdin (aprobando esas cadenas) y no fusiones esa petición.
   - si el validador avisa de `format` (ver «Límites conocidos»).

Lo que ya resuelve `crowdin.yml`, sin pasos manuales: qué ficheros son fuente (`locales/es/app/*.json` y `locales/es/api/*.json`), dónde se escriben las traducciones (`locales/<código de dos letras>/...`, y una carpeta propia para las variantes regionales declaradas en `languages_mapping`), la conservación de la estructura de carpetas, la exclusión de `locale.json`, que un original modificado pierda la aprobación de sus traducciones, el título y la etiqueta de la petición de cambios, y un mensaje de *commit* **sin `[ci skip]`**. Esto último importa: el mensaje por defecto de Crowdin lleva esa marca, GitHub Actions no ejecuta los flujos de un *commit* que la lleve, y una comprobación obligatoria que no se ejecuta se queda «pendiente» para siempre.

## Puesta en marcha de GitHub

### Protección de la rama `main`

En *Settings > Branches* (o *Rules > Rulesets*) del repositorio, para `main`:

- **Exigir una petición de cambios antes de fusionar**, con **al menos 1 aprobación**. La integración de Crowdin no cuenta como revisora.
- **Exigir que pasen las comprobaciones de estado**, con **`validar`** como comprobación obligatoria (aparece en la lista después de la primera ejecución del flujo). El flujo se ejecuta **una vez por petición de cambios**, sobre el resultado de fusionarla con `main` (los `push` solo se validan en `main`), así que su resultado ya tiene en cuenta lo que haya cambiado en `main` hasta ese momento. Exigir además «la rama actualizada antes de fusionar» es más estricto —cubre un cambio de `main` posterior a la última ejecución— a costa de pulsar «Update branch» en cada petición de Crowdin; es recomendable mientras el volumen lo permita. Si algún día se usa una cola de fusión, el flujo ya responde al evento `merge_group`.
- **Aplicar las reglas también a quien administra** («Do not allow bypassing the above settings»).
- **Bloquear los *force push*** y el borrado de la rama.
- Recomendado: un fichero `CODEOWNERS` que exija la revisión de quien mantiene el proyecto para `scripts/`, `.github/`, `crowdin.yml` e `i18n.config.json`, y «Require review from Code Owners». No se incluye aquí porque necesita nombres de usuario reales.
- Recomendado: borrar la rama `l10n_main` después de cada fusión (Crowdin la vuelve a crear), para evitar conflictos.

Quién puede fusionar: solo quienes tengan permiso de escritura en este repositorio. Limítalo al equipo que mantiene AccioPass.

### Webhook hacia la API (el camino «en tiempo real»)

En *Settings > Webhooks > Add webhook* de este repositorio:

| Campo | Valor |
| --- | --- |
| Payload URL | `https://<dominio de la API>/v1/i18n/webhook` |
| Content type | `application/json` |
| Secret | el mismo valor que la variable `I18N_WEBHOOK_SECRET` de la API |
| SSL verification | activada |
| Which events | **«Just the push event»** |
| Active | marcado |

- Genera el secreto con algo como `openssl rand -hex 32`, guárdalo en la configuración de la API y **no lo escribas en ningún repositorio**.
- La API comprueba la firma `X-Hub-Signature-256` y responde `204` si es válida, `401` si no lo es y `404` si no tiene secreto configurado (el webhook está desactivado). En *Recent Deliveries* se ve cada entrega y su respuesta.
- El aviso **no transporta textos**: solo hace que la API vuelva a mirar la rama configurada. Si un aviso se pierde, el sondeo periódico de la API (`I18N_REFRESH_SECONDS`, 300 por defecto) recoge el cambio igualmente.
- Con varias instancias de la API, el aviso llega a una; si comparten el bus de eventos (Redis), esa se lo pasa a las demás y todas cambian a la vez, y si no, las demás se ponen al día con su propio sondeo.
- Repetir una entrega (*Redeliver*) que la API ya atendió no hace nada durante una hora, ni tampoco un aviso de un commit que ya se está sirviendo: no hace falta, el sondeo recoge cualquier cambio.
- **Sin token, la API puede quedarse sin cupo de GitHub**: las preguntas periódicas sin autenticar cuentan contra 60 por hora y por IP de salida aunque no haya cambios. Con más de unas pocas instancias, o un intervalo corto, configura `I18N_GITHUB_TOKEN` (solo lectura, solo este repositorio); está explicado en la documentación de la API.

La configuración de la API (`I18N_SOURCE=github`, `I18N_GITHUB_REPOSITORY`, `I18N_GITHUB_REF`, etc.) está documentada en el repositorio de la API.

## Límites conocidos

- **Formato de lo que exporta Crowdin.** No se ha podido comprobar contra un proyecto real con qué sangría y qué escapes escribe Crowdin los JSON. Por eso, en los idiomas traducidos un formato no canónico es un **aviso** y no un error, y es **uno solo por idioma** (con el número de ficheros), para que no tape los avisos que sí piden una mirada. Es inocuo: los ficheros se leen igual, y la aplicación reescribe su copia al sincronizar. Si tras ver la primera petición real se prefiere uniformidad, se puede normalizar en un paso posterior del flujo.
- **Plurales.** Solo existen `zero`, `one` y `other`, con la regla del español y del inglés (singular solo para 1). Los idiomas con más formas de plural (ruso, polaco, árabe…) tienen que redactar `other` de modo que sirva para todas las cantidades. Para Crowdin cada forma es una cadena independiente, sin relación entre ellas (su formato JSON genérico no entiende de plurales): de ahí la nota de contexto que piden las normas de traducción.
- **Escritura de derecha a izquierda.** Las marcas de dirección (U+200E, U+200F, U+061C) se rechazan junto con los demás controles bidireccionales, porque el mismo mecanismo sirve para falsear lo que se lee. El árabe y el hebreo funcionan con el algoritmo bidireccional normal; un texto que mezcle marcadores o palabras latinas puede necesitar otra redacción en vez de una marca.
- **Los textos protegidos no cambian en vivo** y los idiomas no incluidos en la compilación los muestran en español: ver «Textos protegidos».
- **Variantes regionales.** `%two_letters_code%` no las distingue y solo están previstas las de `crowdin.yml`; los códigos de Crowdin de esa lista no se han podido comprobar uno a uno contra su tabla de idiomas. Ver «Añadir un idioma».
- **La validación automática no entiende el significado.** Ver «Modelo de seguridad»: la revisión humana no es opcional.
- **La comprobación `validar` no es una frontera de seguridad por sí sola.** Se ejecuta con el flujo, el validador y la guarda de la propia rama que se propone fusionar; quien pueda escribir en esa rama podría modificarlos (la guarda señala cualquier fichero fuera de `locales/`, incluidos ellos, pero también ella es un fichero de la rama). Lo que protege `main` es la aprobación obligatoria de una persona, y lo que protege a las aplicaciones si todo lo demás falla es que la API y la aplicación validan por su cuenta con su propia copia de las reglas, y que los textos más sensibles no viajan.
