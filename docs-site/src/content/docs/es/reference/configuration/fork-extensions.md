---
title: Configuración del Fork
description: Controles de proveedores, recuperación, modelos personalizados y diagnóstico añadidos por el Fork de Trendymen.
---

Estos ajustes complementan la configuración del proyecto original. El comportamiento de compatibilidad se describe en [Extensiones del Fork](/es/reference/fork-extensions/).

<a id="model-api-listener"></a>

## Listener de la API de modelos

`forkModelApiListener` solo acepta `{ "enabled": boolean }` y su valor predeterminado es `{ "enabled": false }`. Omitirlo o usar `false` conserva el servicio principal existente. El listener usa el mismo proceso, proveedores y política nativa del plano de datos que ese servicio.

Para una API LAN separada, mantén el servicio principal en loopback con un puerto distinto de `10100`. Por ejemplo:

```json
{
  "hostname": "127.0.0.1",
  "port": 10101,
  "forkModelApiListener": { "enabled": true }
}
```

Este modo auxiliar sirve el panel y la API de administración existentes en `http://127.0.0.1:10101` y vincula la API de modelos a `0.0.0.0:10100`. Se admiten otros puertos de administración en loopback si no entran en conflicto con otro listener configurado. Antes de activarlo, configura una clave API o un token nativo del plano de datos; un token de administrador por sí solo no autoriza solicitudes de modelos.

Cuando el servicio principal ya está vinculado a una dirección fuera de loopback, para activar esta opción su puerto debe ser `10100`:

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "forkModelApiListener": { "enabled": true }
}
```

Este modo principal no crea otro listener. El puerto `10100` conserva el comportamiento nativo de administración, health/readiness, enrutamiento y autenticación del servicio principal; no se le aplican las restricciones auxiliares siguientes.

El listener auxiliar acepta todo el plano de datos nativo tras normalizar la ruta de compatibilidad a `/v1/`: detección de modelos, Responses, Chat Completions, Messages, recuento de tokens, imágenes, audio y rutas WebSocket/SSE admitidas. La disponibilidad sigue dependiendo de los proveedores y de la configuración de funciones de cada ruta nativa. No hay una lista separada de modelos o endpoints permitidos, y los cuerpos de solicitud, parámetros de consulta y respuestas de negocio conservan su tratamiento nativo. Se rechaza el prefijo `/v1/link-management`.

El endpoint auxiliar devuelve JSON `404` para el panel, la API de administración, la emisión de sesiones, el emparejamiento, health/readiness y Remote Workspace. Esto también se aplica a clientes locales, credenciales de administrador, sesiones existentes de la GUI y valores `Host` falsificados. Empareja los clientes y administra las cuentas mediante el servicio de administración principal. Las credenciales de modelos conservan sus reglas nativas de ámbito, uso, Direct, credenciales del proveedor y credenciales de audio. Los cambios de credenciales conservan el comportamiento nativo de HTTP y WebSocket; esta opción no añade revocación por fotograma.

Guardar un cambio de topología afecta al siguiente inicio. No mueve un socket activo ni cambia los puertos automáticamente; una topología inválida o un puerto requerido ocupado provoca un error en lugar de seleccionar otro puerto. Reinicia el proxy después de guardar. `ocx status` muestra la URL principal de administración y el estado del listener de modelos. `ocx status --json` añade `forkModelApiListener` sin cambiar `schemaVersion: 1`: `enabled` es el ajuste deseado, mientras que `active`, `hostname` y `port` proceden del proceso en ejecución. `restartRequired` compara la topología iniciada con la guardada. Sin una respuesta verificada del mismo proceso, `active` y `restartRequired` son `null` e `inactiveReason` es `unverified`; un servicio detenido informa `active: false` y `not-running`. Un listener desactivado en un servicio en ejecución informa `disabled`; el modo principal informa `primary-non-loopback` porque no necesita un listener auxiliar. El estado no contiene credenciales.

Cuando un archivo contiene el proveedor retirado OpenCode Free, una lectura activa intenta guardar una copia de recuperación de los bytes originales mientras elimina las entradas retiradas de la vista cargada. Los diagnósticos pasivos no crean esa copia. Se conserva una topología válida con el listener activado; una topología explícita inválida se rechaza en lugar de desactivarse en silencio.

La instalación, el reinicio del servicio del usuario, la conexión desde dispositivos externos y el acceso a proveedores de pago requieren aceptación por separado.

<a id="provider-settings"></a>

## Ajustes del proveedor

| Campo | Comportamiento del Fork |
| --- | --- |
| `agentMessageFormat` | `preserve` conserva los mensajes nativos; `user_message` convierte texto y contenido multimedia completos y legibles en destinos Responses de terceros, incluidos modelos GPT de terceros. Los destinos operados por OpenAI siempre conservan el formato nativo. Sin configurar, se usan los valores predeterminados del destino; el texto cifrado, las partes desconocidas y el contenido vacío no se convierten parcialmente. |
| `inferResponsesMessagePhaseModels` | ID exactos de modelos habilitados para inferir la fase de Responses nativo. Se excluyen los destinos oficiales y las familias de modelos GPT/OpenAI. Los anuncios iniciales que indiquen `final_answer` se reducen a `commentary`; la evidencia del elemento final o evento terminal determina la fase final. Los turnos fallidos o incompletos no reciben una fase final sintética. |
| `defaultMaxOutputTokens`, `modelMaxOutputTokens` | Los valores de salida predeterminados existentes también completan `max_output_tokens` cuando falta en Responses con autenticación por clave. Los ajustes del modelo prevalecen sobre los del proveedor y los valores del cliente sobre ambos. La autenticación forward no recibe un valor inyectado. |

Con una ventana válida y más de 512 tokens estimados restantes, el presupuesto inyectado es `max(512, min(configured, remaining - headroom))`, con un margen de 256–4,096 tokens. Sin esa ventana o con 512 tokens restantes o menos, se conserva el valor configurado para que el proveedor pueda rechazar explícitamente el exceso.

`agentMessageFormat` e `inferResponsesMessagePhaseModels` se usan mediante la configuración o la API de administración. Un campo omitido en POST conserva el último valor; PATCH `null` lo borra. Se rechaza `agentMessageFormat` con POST `null`. La conversión explícita de formato conserva las identidades y los objetos originales de solicitud y repetición.

Sin configurar `agentMessageFormat`, la autenticación forward conserva los elementos nativos `agent_message` conforme al valor predeterminado del proyecto original. Un ajuste explícito `user_message` aún puede convertir contenido legible en destinos de terceros.

`inferResponsesMessagePhaseModels` también cubre las respuestas JSON ordinarias de los modelos de terceros incluidos en la lista. Cuando se cumplen sus condiciones, prevalece la inferencia por modelo para que dos reescrituras con búfer no consuman el mismo tramo final de EOF. Las demás rutas conservan la opción original `messagePhaseInference` por proveedor para SSE y JSON reconstruido a partir de SSE.

El preajuste `opencode-go` establece `preserveResponsesReasoningContent` en `true` solo si está ausente; un `false` explícito tiene prioridad. El ejemplo de rechazo que motivó este ajuste procedía de DeepSeek. No se han validado todos los demás modelos Responses de ese proveedor con repetición conservada.

<a id="gpt-subscription-processing"></a>

## Procesamiento de suscripciones de GPT

`providers.<name>.codexPassthrough` controla 23 operaciones de compatibilidad. Todos los permisos son `true` de forma predeterminada, incluido `normalizeEncryptedContent`. Omitir el objeto, usar `{}` o establecer los 23 valores en `true` conserva el comportamiento anterior. Un permiso no activa una función desactivada: el ritmo de solicitudes, la recuperación de tareas, los reintentos por reset, el transporte WebSocket al proveedor y skills siguen requiriendo sus ajustes y condiciones existentes.

Los permisos solo se aplican cuando el destino final usa `openai-responses`, `authMode: "forward"` y la URL base normalizada `https://chatgpt.com/backend-api/codex`, con entrada Responses nativa por HTTP, SSE o WebSocket. Esto incluye el inicio de sesión principal Direct y las cuentas Pool principales o añadidas. Cambiar el nombre del proveedor o seleccionar un adaptador por modelo no altera esa comprobación. La autenticación por clave, los proveedores GPT de terceros, otros modelos en otros destinos y la entrada Chat Completions o Anthropic conservan su comportamiento. Cada destino de fallback se comprueba por separado.

En el panel, abre los ajustes del proveedor y despliega **Official GPT subscription processing**. Los cuatro grupos siguientes permiten activar o desactivar permisos individuales o desactivarlos todos. Guardar afecta a la siguiente solicitud o turno WebSocket; el turno en curso y sus intentos de fallback conservan los permisos capturados. La revocación de credenciales de cuenta mantiene su comportamiento existente.

Las rutas de estas tablas son relativas a `codexPassthrough`. Todos los valores predeterminados son `true`.

<a id="request"></a>

### Solicitud

| Campo | Operación permitida al activarlo |
| --- | --- |
| `normalizeRequestParameters` | Limpieza existente de parámetros del backend oficial, valores predeterminados y streaming forzado cuando ya era necesario, además de la proyección automática del historial de búsqueda alojada cuando no se declara esa herramienta. La activación explícita del proveedor `projectResponsesLiteHostedSearchHistory` sigue siendo independiente. |
| `expandRequestHistory` | Amplía el historial de continuación guardado para `previous_response_id`. |
| `normalizeEncryptedContent` | Decodifica envolturas OCX1 y normaliza el texto cifrado de compactación nativa bajo las condiciones existentes de cambio de identidad. Al desactivarlo se omite esa normalización; el tratamiento de fallos de recuperación de tareas permanece separado. |
| `snapshotSkillsCatalog` | Aplica la instantánea del catálogo de skills cuando lo requieran sus ajustes existentes. |
| `rewriteAnnotationInstructions` | Reescribe las instrucciones de anotación de Codex reconocidas para solicitar directivas sin comillas invertidas. |
| `bridgeLiteMetadata` | Transfiere un encabezado Lite válido al construir un fotograma WebSocket canónico hacia el proveedor; el encabezado HTTP explícito tiene prioridad sobre los metadatos del mismo nombre. Los metadatos de la solicitud HTTP y los demás campos permanecen sin cambios. |

<a id="response"></a>

### Respuesta

| Campo | Operación permitida al activarlo |
| --- | --- |
| `backfillResponseFields` | Completa ID de elementos, estado de mensajes y anotaciones de texto que falten en la respuesta. |
| `repairResponseToolCalls` | Aplica las reparaciones autorizadas existentes de llamadas a herramientas, con las condiciones originales del mapa de herramientas. |
| `redactUpstreamErrors` | Aplica la ocultación y normalización generales de errores del proveedor. Las credenciales privadas inyectadas siguen protegidas cuando está desactivado. |
| `privateSseReadDeadline` | Conserva el plazo fijo de 5 segundos para la primera salida SSE protegida y los bloques incompletos. Al desactivarlo, usa `stallTimeoutSec` para la inactividad del flujo y conserva la cancelación, los presupuestos de memoria y la ocultación de credenciales privadas. |
| `upstreamWsSilenceDeadline` | Conserva el plazo de silencio de 90 segundos mientras espera la primera respuesta WebSocket del proveedor. Los fotogramas y pong reinician el plazo. Al desactivarlo, se conservan el plazo de conexión, los ping, la cancelación y los presupuestos de transporte. |
| `privateErrorBodyReadDeadline` | Conserva los plazos fijos de 5 segundos para el total, el primer byte y la inactividad al leer cuerpos de error HTTP protegidos con credenciales privadas. Al desactivarlo, elimina el plazo total fijo y usa `stallTimeoutSec` para las esperas del primer byte y de inactividad; la cancelación, el límite de 64 KiB y la ocultación de credenciales siguen activos. |
| `synthesizeTerminalFailure` | Aplica el tratamiento existente de fallo terminal sintético cuando no llega un evento terminal utilizable. |
| `normalizeHostedImages` | Convierte los resultados de imágenes alojadas admitidos para el cliente y elimina sus rutas de presentación de la entrada posterior. |

En un intento Combo de Responses nativo con streaming, incluso con `synthesizeTerminalFailure: false`, un `response.done` real con `response.status: "completed"` y un array de salida sigue sujeto al contrato original de herramientas obligatorias. La comprobación no modifica un bloque válido. Con `repairResponseToolCalls: false`, no puede contar como cumplimiento un nombre reparado que el cliente no recibió. Una llamada obligatoria ausente solo puede reintentarse antes de confirmar la respuesta y cuando la repetición sea segura; los efectos observados de herramientas alojadas impiden repetirla.

Cuando el valor efectivo de `maxInboundBodyBytes` supera 256 MiB, se aplica el presupuesto compartido de admisión `maxConcurrentInboundBodyBytes`. Para un cuerpo leído de forma normal, su reserva se actualiza según los tamaños descomprimido y serializado antes de transferir la reserva de texto de solicitud del Fork. El texto JSON conservado tiene una reserva separada del translator budget. La reserva de admisión se mantiene hasta EOF de la respuesta, error o cancelación concluida; la reserva de texto se libera con su origen cuando termina, falla, se cancela o se aborta. Consulta [Admisión del cuerpo entrante](/es/reference/inbound-body-admission/) para los límites y el alcance originales.

Un turno Remote Link puede llegar con un cuerpo ya analizado. El proxy aplica primero el límite original de tamaño serializado y la observación del presupuesto. Solo cuando se necesita un origen del Fork y aún no se ha conservado, serializa y conserva una copia adicional de texto JSON. El translator budget observa su tamaño; el texto y su observación se liberan con el origen. Un JSON válido con anidamiento profundo puede desbordar la pila de `JSON.stringify` y devolver un error de JSON no válido. La publicación de Link WebSocket sigue bloqueada y este defecto debe corregirse antes de habilitarla. El uso real de memoria de Remote Link aún no se ha validado y esta ruta no demuestra el objetivo original de evitar una segunda copia.

<a id="headers"></a>

### Encabezados

| Campo | Operación permitida al activarlo |
| --- | --- |
| `synthesizeRoutingHint` | Genera `x-codex-routing-hint` a partir del cuerpo final de la solicitud. |
| `synthesizeSessionId` | Genera un `session_id` ausente. |
| `addResponseRequestId` | Añade el encabezado de respuesta `x-opencodex-request-id` de OCX. |
| `addResponseBrowserHeaders` | Añade los campos CORS y de encabezados expuestos de OCX para el navegador. Desactivarlo puede impedir que los clientes de navegador de otro origen lean las respuestas. |

Desactivar la generación de encabezados no elimina los encabezados explícitos del cliente o proveedor. Siguen aplicándose la autenticación, la identidad de la cuenta seleccionada, el encuadre HTTP/WebSocket requerido y las comprobaciones existentes de transporte y seguridad.

Con `synthesizeRoutingHint: false`, una indicación de enrutamiento configurada en el proveedor tiene prioridad sobre la del cliente. Con la generación activada, la indicación existente derivada del cuerpo puede sustituir cualquiera de las dos.

<a id="local-error-policies"></a>

### Políticas de errores locales

| Campo | Comportamiento al desactivarlo |
| --- | --- |
| `localErrorPolicies.resetReplayRefusal` | No emite la explicación opcional de Codex sobre la negativa a repetir ni su encabezado `x-should-retry: false`. Un envío de resultado ambiguo sigue sin poder repetirse; un fallo de pasarela requerido sigue siendo 502 o 504. |
| `localErrorPolicies.requestPacingAdmission` | Omite para este intento la admisión local opcional por ritmo de solicitudes. |
| `localErrorPolicies.inputAdmissionPrecheck` | Omite la comprobación local opcional de tamaño estimado de entrada. Los límites obligatorios siguen aplicándose. |
| `localErrorPolicies.accountSoftPrecheck` | Omite las comprobaciones ordinarias de cuota y enfriamiento en caché. La pausa explícita, los bloqueos de cuenta, la reautenticación, las políticas de crédito y reserva y otras decisiones protegidas de cuenta permanecen activas. |
| `localErrorPolicies.transportErrorMapping` | Usa un 502 `Bad Gateway` o un 504 `Gateway Timeout` simple para los fallos de transporte locales en lugar de la explicación opcional de error de Codex. |

Estos ajustes no ocultan errores reales del proveedor, incluidas las respuestas 429 de OpenAI, ni fallos de conversión o descifrado de recuperación de tareas. Los presupuestos compartidos de envío y las comprobaciones de autenticación e identidad siguen vigentes. Desactivar una negativa o conversión de errores no añade reintentos del proxy. Sin la indicación de negativa a repetir, el cliente Codex puede reintentar bajo su propio presupuesto; si el proveedor ya procesó la solicitud, podría repetir el trabajo o consumir más cuota.

<a id="saving-and-clearing-overrides"></a>

### Guardar y borrar valores explícitos

El archivo de configuración y la configuración JSON completa aceptan valores booleanos en los campos finales. Para restablecer un valor predeterminado, elimina el campo. Por ejemplo, este fragmento de proveedor desactiva la reescritura de anotaciones y la comprobación local de cuota ordinaria, y deja los demás permisos en sus valores predeterminados:

```json
{
  "codexPassthrough": {
    "rewriteAnnotationInstructions": false,
    "localErrorPolicies": {
      "accountSoftPrecheck": false
    }
  }
}
```

`PATCH /api/providers?name=<name>` combina solo los campos finales proporcionados bajo `codexPassthrough`. PATCH `null` elimina un valor explícito: un campo final recupera su valor predeterminado, `localErrorPolicies: null` borra ese grupo y `codexPassthrough: null` borra el objeto completo. GET devuelve los valores explícitos guardados sin materializar los predeterminados. No uses `null` en el archivo de configuración ni interpretes el borrado como desactivación.

Para desactivar todos los permisos, usa la acción del panel o establece los 23 campos finales en `false`:

```json
{
  "codexPassthrough": {
    "normalizeRequestParameters": false,
    "expandRequestHistory": false,
    "normalizeEncryptedContent": false,
    "snapshotSkillsCatalog": false,
    "rewriteAnnotationInstructions": false,
    "bridgeLiteMetadata": false,
    "backfillResponseFields": false,
    "repairResponseToolCalls": false,
    "redactUpstreamErrors": false,
    "privateSseReadDeadline": false,
    "upstreamWsSilenceDeadline": false,
    "privateErrorBodyReadDeadline": false,
    "synthesizeTerminalFailure": false,
    "normalizeHostedImages": false,
    "synthesizeRoutingHint": false,
    "synthesizeSessionId": false,
    "addResponseRequestId": false,
    "addResponseBrowserHeaders": false,
    "localErrorPolicies": {
      "resetReplayRefusal": false,
      "requestPacingAdmission": false,
      "inputAdmissionPrecheck": false,
      "accountSoftPrecheck": false,
      "transportErrorMapping": false
    }
  }
}
```

Con todos los permisos desactivados, se conservan los valores JSON de la solicitud, la presencia de campos, los campos desconocidos y el orden de los arrays, sujetos al enrutamiento explícito de modelo/Fast, la autenticación de la cuenta seleccionada, las reglas de transporte requeridas y la activación independiente del proveedor `projectResponsesLiteHostedSearchHistory`. Deja esa opción desactivada para conservar sin cambios el historial de búsqueda alojada. El JSON puede volver a serializarse. No se garantiza que las respuestas sean idénticas byte por byte cuando se requiere encuadre o protección de credenciales privadas. Al desactivar la reescritura de errores, los fotogramas de error WebSocket del cliente conservan el cuerpo completo del error del proveedor en `response`.

Las credenciales privadas realmente inyectadas por OCX siguen protegidas antes de la entrega, incluidas las credenciales Pool o principales guardadas y los valores sensibles de encabezados configurados. Si no se puede garantizar la entrega segura de una respuesta correcta o un flujo SSE, el proxy devuelve `upstream_error_protection_failed` antes de confirmar la respuesta o aborta un flujo ya confirmado. No inventa un evento terminal de éxito.

Para un error HTTP protegido, el proxy lee como máximo 64 KiB con decodificación UTF-8 estricta. Un cuerpo completo y válido marcado como JSON se oculta cadena por cadena; los demás textos se ocultan como un todo. Un JSON inválido marcado como JSON solo se conserva sin cambios si no contiene barras invertidas y la ocultación no encuentra valores privados; de lo contrario, se descarta el cuerpo. También se descartan los cuerpos demasiado grandes y los fallos de decodificación. Cuando se descarta el cuerpo, Direct conserva el estado del proveedor: de forma predeterminada, el formateador original devuelve JSON solo con el estado; con `redactUpstreamErrors: false`, devuelve un cuerpo vacío. Combo conserva el estado y clasifica sin el cuerpo descartado. Los plazos y la cancelación existentes siguen aplicándose.

Para una respuesta correcta cuyo cuerpo no sea SSE ni JSON, el proxy cancela el cuerpo del proveedor y devuelve este error de protección antes de entregarlo cuando hay un valor privado que proteger. Las respuestas sin cuerpo y aquellas sin valores privados que proteger conservan su comportamiento de entrega existente. Un valor que el cliente ya posee no genera esta restricción.

Para eliminar solo el plazo SSE fijo de 5 segundos, establece `codexPassthrough.privateSseReadDeadline` en `false` o desmarca **Private SSE fixed 5-second deadline** en los ajustes de respuesta del proveedor. Esto no cambia el plazo acotado del cuerpo de error HTTP ni permite una salida insegura. Una espera más larga puede retrasar un fallo; `stallTimeoutSec` y la cancelación de la solicitud siguen limitando los flujos inactivos.

Los otros dos plazos son ajustes de respuesta independientes. Establece `upstreamWsSilenceDeadline` en `false` para eliminar el límite adicional de silencio de 90 segundos del WebSocket al proveedor. Establece `privateErrorBodyReadDeadline` en `false` para eliminar el límite fijo de 5 segundos del cuerpo de error HTTP privado. Este último usa el ajuste normal `stallTimeoutSec`, cuyo valor predeterminado es 300 segundos; un `0` explícito desactiva ese límite de inactividad. Ninguno de los permisos cambia los reintentos por reset, la actualización y repetición por 401, la rotación de cuentas ni `agentTaskRecovery`. El ajuste existente `codexMainAccountHardLock` controla por separado el bloqueo de cuota de la cuenta principal.

Los registros identifican los fallos de protección privada con un código de error local `private-*` y conservan el estado original del encabezado de respuesta en `upstreamHttpStatus`, incluidas las filas por intento y el uso persistido. El panel muestra ese estado por separado y etiqueta el mensaje de protección como motivo local. Por ejemplo, un HTTP 200 del proveedor seguido de un fallo de plazo local se registra por separado del 502 final. Las filas históricas sin este campo no pueden recuperar el estado original.

<a id="custom-models-and-context-caps"></a>

## Modelos personalizados y límites de contexto

Los tipos, las operaciones CRUD y las filas del catálogo de modelos personalizados ya existen en el proyecto original. El Fork añade escrituras estrictas, recuperación por fila, combinación concurrente por ID estable y una proyección pública de campos conocidos. Los campos opacos desconocidos permanecen internos. Una fila personalizada que sustituye una fila detectada conserva su `pricingStatus` detectado.

`customModels[].codexToolMode` admite `code_mode_only`, `shell` o herencia. Omitirlo al crear usa herencia; omitirlo al actualizar conserva el valor guardado; actualizarlo con `null` lo borra. La CLI usa `--tool-mode code_mode_only|shell|inherit`; esto complementa el consumidor existente del campo en el catálogo.

Si falla el guardado en `PUT /api/provider-context-caps`, se restauran los campos activos de límite de contexto de esa ruta y las eliminaciones pendientes sin actualizar el catálogo. Esta garantía no se extiende a todos los campos de configuración.

Si `POST /api/providers` falla antes de publicar, se restaura la entrada anterior del proveedor y, para `setDefault: true`, el valor predeterminado anterior. Un `ConfigWritePublishedError` conserva el proveedor y el valor predeterminado ya publicados para que sigan siendo coherentes con el disco.

<a id="encrypted-task-recovery"></a>

## Recuperación de tareas cifradas

La recuperación sigue desactivada de forma predeterminada y, cuando se activa, usa una solicitud autenticada adicional a ChatGPT. Este ejemplo activa la recuperación con los valores predeterminados del backend estricto del Fork:

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-luna",
    "reasoningEffort": "medium",
    "timeoutMs": 120000,
    "maxRetries": 2,
    "retries": 0
  }
}
```

Para las envolturas estrictas admitidas del backend `NEW_TASK` y `MESSAGE` de hijo a padre, `timeoutMs` limita cada intento (120000 ms de forma predeterminada), las esperas por el primer byte o inactividad están limitadas a 45 segundos y `maxRetries` permite hasta dos intentos adicionales por tiempo de espera agotado. Las demás tareas cifradas admitidas usan un único plazo compartido (45000 ms de forma predeterminada o el valor configurado de `timeoutMs`) y no usan `maxRetries`. `retries` cubre fallos HTTP o de transporte transitorios dentro del plazo activo; la cancelación y `invalid_encrypted_content` detienen ambas rutas.

La recuperación nativa por errores 5xx transitorios solo admite un `NEW_TASK` estricto y después repite una vez el mismo destino seleccionado usando el presupuesto compartido de envío. El tiempo de espera agotado de un `MESSAGE` principal cifrado y admitido puede generar un aviso de reenvío sin texto cifrado; no afirma que el mensaje se haya leído. El texto cifrado estricto y los cuerpos recuperados se excluyen del almacenamiento de continuación.

<a id="diagnostics-and-local-installation"></a>

## Diagnóstico e instalación local

Los diagnósticos del proveedor son estructurales de forma predeterminada. Los artefactos de texto requieren tanto la depuración del proveedor como `provider-text`, disponibles mediante CLI, API y panel:

```bash
ocx debug provider on
ocx debug provider-text on
ocx debug provider-text off
```

Los registros y artefactos referenciados comparten grupos de 4 MiB bajo directorios de fecha y hora UTC. Las dos raíces conservan como máximo siete días y 20 GiB de datos administrados; la limpieza elimina el registro más antiguo antes que sus artefactos. Las entradas ajenas inseguras o ilegibles permanecen fuera de ese límite administrado. Las muestras se ocultan y limitan por cadena y turno. Detén el proxy antes de eliminar manualmente tanto `provider-debug` como `provider-debug-artifacts`; eliminar solo los artefactos rompe las referencias conservadas.

`bun run install:local` es una acción de mantenimiento local solicitada explícitamente. Prepara y valida sin conexión el cierre de dependencias, sincroniza Volta y comprueba que el servicio esté listo antes de confirmar la sustitución. En macOS activa `OCX_DEBUG=1` y `OCX_PROVIDER_TEXT_DEBUG=1`; `--no-restart` escribe la configuración de servicio en el plist del disco sin recargarlo. El parche de la pila de fuentes se mantiene y el antiguo parche CSS de desplazamiento está retirado.

La transacción de instalación compartida exige autorización síncrona de sustitución y comprueba la identidad del marcador pendiente antes y después de esa autorización en cada intento de cambio del paquete activo. Un estado de recuperación inseguro impide recuperar el launcher y el servicio incluso si se informó una reversión. Un fallo `pending-marker` solo se considera seguro cuando el paquete anterior no se modificó y se confirmó la ausencia del marcador; en otro caso, inspecciona el estado de la transacción antes de reintentar.

La recuperación al iniciar también comprueba la entrada del directorio del marcador con `lstat`. Solo `ENOENT` significa que el marcador está ausente. Un enlace simbólico, un archivo no regular o un fallo de stat, lectura o análisis impide la limpieza y recuperación automáticas, y conserva el marcador, la copia de seguridad del paquete y el registro de recuperación. Un fallo de lectura después de encontrar la entrada no se trata como ausencia.
