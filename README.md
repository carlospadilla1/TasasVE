# Tasas Venezuela · PWA

Aplicación web instalable que muestra tasas de referencia del dólar en Venezuela con una UI oscura y mobile-first. La app consume Cotizave para obtener tasas de BCV, Binance P2P y otros mercados, manteniendo la API key fuera del navegador.

---

## Objetivo principal

La app debe cumplir dos reglas críticas:

1. La API key nunca puede quedar expuesta en JavaScript del cliente.
2. La app debe seguir funcionando tanto en local como en Netlify sin exponer secretos al navegador.

Para eso, la arquitectura correcta es:

- Frontend llama a un proxy
- El proxy corre en el servidor
- El proxy guarda la key en una variable de entorno
- El proxy consulta Cotizave y devuelve los datos al navegador

---

## Arquitectura correcta

### Flujo seguro

```text
Navegador
  └─> /.netlify/functions/rates
        └─> Netlify Function
              └─> process.env.COTIZAVE_API_KEY
                    └─> fetch('https://api.cotizave.com/v1/fx/rates', { headers: { 'X-API-Key': ... } })
                          └─> responde JSON al navegador
```

Esto es lo que debe usarse en producción. La key no se ve en el navegador ni en el código estático.

### Flujo local de desarrollo

```text
Navegador
  └─> http://localhost:3000/api/rates
        └─> server.js
              └─> process.env.COTIZAVE_API_KEY
                    └─> fetch('https://api.cotizave.com/v1/fx/rates')
                          └─> devuelve JSON
```

El archivo `server.js` sirve para entorno local y no debe ser la referencia de seguridad en producción.

---

## Archivos del proyecto

| Archivo | Propósito |
|---|---|
| `index.html` | UI, cálculo, render, PWA, lógica de fetch y fallback. |
| `config.js` | Configuración general del proyecto. Debe quedar sin secretos reales. |
| `server.js` | Proxy local para desarrollo. |
| `sw.js` | Service worker para precache y caché de shell/API. |
| `manifest.json` | Configuración PWA. |
| `netlify/functions/rates.js` | Proxy serverless de Netlify. La lógica segura va aquí. |
| `icons/` | Íconos y favicon. |
| `README.md` | Documentación del proyecto. |

---

## Seguridad de la API key

### Lo correcto

La clave debe vivir solo en backend o variables de entorno:

- Netlify: `COTIZAVE_API_KEY`
- local: `COTIZAVE_API_KEY` en el shell o `.env` local

En la función de Netlify se usa así:

```js
const apiKey = process.env.COTIZAVE_API_KEY;
```

y luego:

```js
fetch('https://api.cotizave.com/v1/fx/rates', {
  headers: { 'X-API-Key': apiKey, Accept: 'application/json' }
});
```

### Lo incorrecto

No debe quedar en archivos del frontend como:

- `config.js`
- `index.html`
- `script` inline en HTML
- cualquier archivo estático servido por navegador

Si la key aparece en el frontend, cualquier usuario puede verla inspeccionando la página.

---

## Por qué el local todavía mostraba tasas

Aunque el archivo `config.js` no tenga la key, la app puede seguir mostrando valores por una razón muy específica: hay un fallback público.

En la lógica de `index.html` se intenta esto en orden:

1. `/.netlify/functions/rates`
2. `./api/rates`
3. `https://r.jina.ai/https://cotizave.com`

Y esa última ruta es un bridge de solo lectura que parsea contenido público de Cotizave y genera las tasas en el navegador.

Eso explica por qué en local la app puede seguir mostrando tasas aunque la key haya sido retirada del frontend: el navegador está obteniendo una copia pública alternativa.

> En otras palabras: no siempre significa que la app siga usando la API privada; puede estar usando el fallback público o un caché viejo del navegador.

---

## Cómo se ejecuta localmente

```bash
node server.js
```

Luego abre:

```text
http://localhost:3000
```

El servidor sirve los archivos estáticos y expone `/api/rates` para evitar el problema de CORS.

### Puerto personalizado

```bash
PORT=8080 node server.js
```

---

## Despliegue en Netlify

### Requisito

Debes crear la variable de entorno en Netlify:

```text
COTIZAVE_API_KEY
```

### Esto es lo que la app usa

```text
/.netlify/functions/rates
```

La función de Netlify responde a esa ruta y ejecuta la consulta al upstream con la key del servidor.

### Recomendación

- No publiques la key en `config.js`
- No la pongas en `index.html`
- No la guardes en archivos de frontend
- Mantén la key solo en Netlify Environment Variables

---

## Caches y razón de “parece que tiene la vieja versión”

El navegador puede seguir mostrando contenido viejo por dos motivos:

1. Caché del navegador
2. Service worker (`sw.js`) sirviendo una versión anterior

Esto es especialmente común con PWA.

Cuando el SW está activo, puede seguir entregando archivos viejos aunque ya hayas quitado la key del repo. Por eso, después de un cambio de seguridad, es necesario:

- hacer deploy nuevo
- limpiar caché del navegador
- unregister el service worker
- recargar con Ctrl + F5

### En Chrome / Edge

1. Abrir DevTools
2. Ir a Application
3. Service Workers
4. Unregister
5. Clear storage
6. Recargar la página

---

## Uso de la función de Netlify

La función se encuentra en:

```text
netlify/functions/rates.js
```

y hace esto:

- acepta `OPTIONS` para CORS
- acepta solo `GET`
- valida si existe `COTIZAVE_API_KEY`
- llama a `https://api.cotizave.com/v1/fx/rates`
- agrega el header `X-API-Key`
- devuelve la respuesta al navegador

Si no existe la variable de entorno, responde con:

```json
{ "code": "missing_api_key" }
```

---

## Nota importante sobre la seguridad real

La API de Cotizave debe usarse desde el backend, nunca desde el navegador.

Si una key aparece en un archivo estático, la clave quedó expuesta en el cliente y debe considerarse comprometida. En ese caso, lo correcto es:

- rotar la key en Cotizave
- cambiar la variable de entorno en Netlify
- redeployar
- limpiar caché del navegador

---

## PWA y comportamiento offline

La app usa el service worker para:

- precachear el shell de la app
- mantener la interfaz disponible offline
- guardar el último JSON de tasas en caché

Esto es útil, pero también explica por qué se puede ver una versión vieja si no se limpia el caché del navegador.

---

## Recomendación final

La configuración ideal es:

- `config.js` sin secretos reales
- `netlify/functions/rates.js` como único punto de acceso a Cotizave
- `COTIZAVE_API_KEY` en Netlify
- `server.js` solo para pruebas locales
- evitar cualquier fallback público en producción

Con eso, la app mantiene la seguridad y la funcionalidad correcta en Netlify y en local.
