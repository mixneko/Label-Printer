# Label Printer

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · **Español** · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Aplicación ligera de diseño e impresión de etiquetas que sustituye a BarTender Designer. Impresora de destino: TSC TTP-244 Pro (203 dpi, TSPL2), mediante una impresora instalada en Windows (RAW) o directamente por Raw TCP a través de un servidor de impresión.

Tecnología: Tauri 2 (backend en Rust) + TypeScript + Konva.js (editor de lienzo).

## Entorno de desarrollo (Windows)

1. [Node.js LTS](https://nodejs.org/)
2. [Rust](https://rustup.rs/) (requiere MSVC: instale la carga de trabajo «Desarrollo para el escritorio con C++» de Visual Studio Build Tools)
3. WebView2 Runtime (incluido en Windows 11)

```powershell
npm install
npm run tauri icon app-icon.png   # solo la primera vez: genera src-tauri/icons
npm run tauri dev                 # modo de desarrollo
cargo test --manifest-path src-tauri/Cargo.toml   # pruebas unitarias de Rust
```

## Compilación y distribución

```powershell
npm run tauri build
```

Resultado:

- `src-tauri/target/release/Label Printer.exe`: un único ejecutable; basta con copiarlo y usarlo (requiere WebView2, incluido en Win11).
- `src-tauri/target/release/bundle/nsis/*-setup.exe`: instalador con el lanzador de WebView2 incluido, por lo que también se instala en Win10; se instala para el usuario actual y no necesita permisos de administrador.

## Actualizaciones automáticas

La versión instalada consulta GitHub una vez en segundo plano al iniciar (solo lee la información pública de las versiones y no envía ningún dato). Si hay una versión nueva, aparece un cuadro de diálogo; con «Actualizar ahora» se descarga dentro de la aplicación, se verifica su firma, se instala y la aplicación se reinicia sola. Puede desactivarlo en «Ayuda → Buscar actualizaciones al iniciar» o comprobar manualmente en cualquier momento con «Ayuda → Buscar actualizaciones». La versión portátil no puede actualizarse en el sitio y abre la página de descarga.

Mantenedores: el flujo de publicación (`.github/workflows/release.yml`) necesita el secreto de repositorio `TAURI_SIGNING_PRIVATE_KEY` (clave privada de firma de actualizaciones, creada con `tauri signer generate`; la clave pública está en `src-tauri/tauri.conf.json`). Si se pierde la clave privada, ya no se podrán enviar actualizaciones a los usuarios existentes.

## Arquitectura

- El front-end convierte la etiqueta en un mapa de bits de 1 bit y el back-end lo transforma en TSPL (`SIZE/GAP/BITMAP/PRINT`).
- Por defecto el trabajo pasa por el spooler de Windows como datos **RAW** a una impresora instalada (el controlador no traduce nada; el TSPL se envía tal cual). También se puede cambiar a una conexión directa Raw TCP (por ejemplo `192.168.1.100:9103`).
- Se usan las fuentes instaladas en Windows (WebView2 lee `C:\Windows\Fonts` y las fuentes del usuario). Al cambiar de equipo, ese equipo también debe tener instaladas las mismas fuentes.
- El papel es de 62,5×30 mm y la etiqueta de 60×30 mm; ambos se pueden cambiar en la interfaz y la etiqueta se centra en el papel.
- El texto de la etiqueta puede usar variables `{{campo}}` (los encabezados de columna de Excel). Número de etiquetas impresas = número de filas marcadas en la tabla de datos.

## Ejemplos (`samples/`)

- `範例標籤.lpxl` + `範例貨品清單.csv`: una etiqueta de producto ficticia de 60×30 mm con sus datos (campos: nombre, código, lote, caducidad). Muestra variables, código QR, código de barras, formatos de fecha y el «área máxima» del texto (un nombre largo se reduce automáticamente).
- `商品清單.xlsx` (dos hojas) y `商品清單-big5.csv`: para probar la importación.
- Regenerar los ejemplos xlsx / csv: `cargo run --manifest-path src-tauri/Cargo.toml --example make_samples`

## Hoja de ruta

- [x] Estructura del proyecto, objetos de texto, impresión
- [x] Objetos de código de barras / código QR / imagen / línea / rectángulo, lista desplegable de fuentes (las instaladas en el sistema)
- [x] Guardar y abrir etiquetas
- [x] Orígenes de datos locales Excel / CSV (botón «Elegir origen de datos»), impresión por lotes, vista previa (la primera fila contiene los nombres de los campos y cada fila siguiente es un registro; marque las filas que desea imprimir y los `{{campo}}` se toman de esa fila. No hace falta una columna de «copias» en Excel; se admiten .xlsx/.xlsm/.xls y .csv, y el CSV detecta automáticamente UTF-8 / Big5 y el separador)
- [x] Calibración de impresión: densidad, velocidad, texto en negrita, posición de corte, avance adicional, ajuste fino de posición horizontal/vertical y «Herramientas → Generar etiqueta de calibración» (marco y regla en mm)
- [x] Comandos nativos de la impresora (`BARCODE` / `QRCODE`): opcional (desactivado por defecto); marque «Imprimir con los comandos nativos de la impresora» en las propiedades de un código de barras o QR. Si el contenido tiene caracteres chinos o el objeto está girado, se usa automáticamente el mapa de bits
- [ ] Confianza de la aplicación: firma de código (Authenticode) para reducir las advertencias de Windows SmartScreen y de los antivirus
- [x] Multilingüe: la interfaz admite inglés, español, alemán, japonés, coreano, chino simplificado y chino tradicional. En el primer inicio se elige según el idioma del sistema y se puede cambiar con el botón del globo, a la derecha de la barra de menús. Este README también existe en siete idiomas. Las traducciones aún deben ser revisadas por hablantes nativos

> Nota: la definición de los bits blanco/negro de TSPL `BITMAP` (0 = imprimir) se invierte en el programa; confirme el resultado en una impresora real.

## Licencia

Publicado bajo la [licencia MIT](LICENSE). Las licencias de los paquetes de terceros se muestran en la aplicación, en «Ayuda → Avisos de licencias de terceros».
