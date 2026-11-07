---
title: Event sourcing, entero dentro de un Durable Object
description: Un Durable Object por tenant guarda el event store, los read models y el trabajo programado. Qué escribe un comando ahí, fila a fila, cuánto cuesta en Cloudflare y cuándo es el diseño equivocado.
tryIt:
  label: Mira una hora punta plegarse desde un snapshot
---

Un event store le pide tres cosas a la máquina en la que corre. Un único escritor, para que los
eventos de un store tengan un solo orden. Un almacenamiento duradero que confirme un lote de filas
de una vez. Y una forma de despertarse más tarde, para el trabajo que sigue a un comando: una
policy, un recordatorio, un reintento.

Un Durable Object de Cloudflare es exactamente eso. Es un actor de un solo hilo con su propia base
de datos SQLite y una alarma. Así que [Bounda](https://docs.bounda.dev/getting-started/) puede meter
en uno una aplicación entera con event sourcing: un objeto por tenant, con su event store, sus read
models, la bandeja de entrada de sus policies y processes, sus comandos programados y sus dead
letters. No hay cola, ni cron, ni una segunda base de datos que mantener.

Este post va de lo que cuesta. Los Durable Objects facturan su almacenamiento por filas, así que la
respuesta honesta es un recuento de filas, y el recuento es lo bastante pequeño como para enseñarlo
entero.

## Un comando, paso a paso

Un comando llega al objeto a través de un Worker, por RPC. Dentro, el objeto carga los eventos del
agregado, los pliega en su estado, ejecuta el handler y guarda los eventos que devuelve. Antes de
responder, pone al día cada read model que proyecta esos eventos, en el mismo objeto, de modo que
la query que venga después ya ve el cambio.

Lo que reacciona a los eventos, una policy o un process, corre en la alarma del objeto, justo
después de que el comando haya respondido. El objeto arma esa alarma él mismo cuando queda trabajo,
y la deja sin armar cuando no lo hay. Un tenant que no recibe nada no cuesta nada más que los bytes
que guarda.

## Ocho filas

Generé el proyecto de Cloudflare que escribe `npm create bounda@0.3.0`, sin cambiar una línea de la
aplicación, y conté cada sentencia que ejecutó el objeto. Cada cursor de SQLite en un Durable Object
informa de `rowsWritten` y `rowsRead`, y esas son las cifras que factura Cloudflare, actualizaciones
de índices incluidas. La aplicación tiene un agregado, `order`, con un comando `placeOrder`, y un
read model, `orders`, cuya vista tiene una clave primaria y un índice sobre `customerId`.

Un `placeOrder`, después de que el primero haya creado el esquema, escribe **8 filas**:

| Filas | Qué |
|---|---|
| 4 | El evento, con los índices del event store |
| 3 | La fila del read model, con su clave primaria y su índice `customerId` |
| 1 | El checkpoint del read model |

Lee 13. Una query `listOrders` que encuentra un pedido lee 3. Un comando que el handler rechaza,
`AlreadyPlaced`, no escribe nada: un rechazo no es un hecho, así que no se guarda nada.

La línea del medio es la que controlas tú. Cada `.index()` de una vista es una fila escrita más
cada vez que cambia una fila de esa vista. En un Durable Object, un índice es una decisión de
factura tanto como de rendimiento.

El resto de operaciones habituales, medidas igual:

| Operación | Filas escritas | Filas leídas | Peticiones |
|---|---|---|---|
| `placeOrder` | 8 | 13 | 1 |
| `placeOrder`, rechazado | 0 | 2 | 1 |
| `listOrders`, una fila | 0 | 3 | 1 |
| `placeOrder` con clave de idempotencia | 11 | 15 | 1 |
| La misma clave otra vez | 0 | 6 | 1 |
| Un rechazo con clave de idempotencia | 3 | 4 | 1 |
| `placeOrder` con `consistency: "eventual"` | 9 | unas 29 | 2 |
| `placeOrder` más una policy que lanza un comando | 19 | unas 67 | 2 |
| Una alarma sin nada pendiente | nunca se arma | | 0 |

Las filas escritas incluyen una por cada vez que el objeto arma su alarma, que Cloudflare factura
como una fila escrita. Una alarma que se ejecuta es una petición más.

Tres de esas líneas merecen una mirada más de cerca.

**La consistencia eventual aquí no ahorra nada.** Un comando que responde antes de que los read
models estén al día escribe las mismas ocho filas, más la alarma, y la alarma que los proyecta es
una segunda petición. Lo que compra es un comando que responde antes, no uno más barato.

**Una policy duplica la factura, y es justo.** La policy confirma cada pedido realizado lanzando
`confirmOrder`. Eso es un segundo comando con su propio evento, más la fila de la bandeja de entrada
que confirma el intento de la policy entero o nada, más los checkpoints que siguen al stream.
Diecinueve filas por dos comandos y una reacción que no puede quedarse a medias.

**Una clave de idempotencia cuesta tres filas y ahorra el resto.** La clave se guarda con la
respuesta, en la misma transacción que los eventos. Un reintento con la misma clave no escribe nada
y responde lo que respondió el primer intento. Un rechazo con clave también se recuerda, y por eso
escribe tres filas donde un rechazo normal no escribe ninguna.

## Lo que cuestan ocho filas

Precios y límites de las páginas de Cloudflare de [precios de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(actualizada el 18 de octubre de 2026), [límites](https://developers.cloudflare.com/durable-objects/platform/limits/)
(7 de noviembre de 2026) y [precios de Workers](https://developers.cloudflare.com/workers/platform/pricing/)
(2 de octubre de 2026), en inglés.

**En el plan Free**, las filas escritas se acaban primero: 100.000 al día son unos **12.500
comandos al día** como este. Las peticiones (100.000 al día) y las filas leídas (5 millones al día)
quedan lejos. Pasado cualquier límite, las operaciones de ese tipo fallan hasta que el día se
reinicia a las 00:00 UTC.

**En el plan Paid** (5 $ al mes), van incluidas 50 millones de filas escritas al mes, que son
**6,25 millones de comandos**. Las peticiones a Durable Objects se acaban antes, en un millón al
mes, pero son baratas: los otros 5,25 millones cuestan menos de un dólar. Pasado lo incluido, un
millón de comandos más cuesta:

| | Por millón de comandos |
|---|---|
| 8 millones de filas escritas, a 1,00 $ el millón | 8,00 $ |
| 1 millón de peticiones a Durable Objects | 0,15 $ |
| 1 millón de peticiones al Worker de delante | 0,30 $ |
| 13 millones de filas leídas | unos 0,01 $ |
| Duración | menos de 0,02 $ |
| **Total** | **unos 8,50 $** |

La duración se factura por tiempo de reloj mientras el objeto está activo, a 128 MB. Un comando
tardó cerca de medio milisegundo en workerd local, en un portátil; en producción será más lento,
pero incluso a 10 ms, un millón de comandos son 1.250 GB-s, frente a 400.000 incluidos. Un objeto
inactivo que puede hibernar no paga duración, y un objeto sin nada pendiente no tiene alarma que lo
despierte.

**El almacenamiento** creció unos 600 bytes por comando en esta aplicación, el evento y la fila del
read model juntos. Son unos 0,6 GB por millón de comandos, y se acumulan: los eventos no se borran
nunca, así que los bytes se quedan. Van incluidos 5 GB-mes, y después 0,20 $ por GB-mes.

El patrón está claro: las escrituras son la factura. El recuento de arriba es el que hay que
multiplicar por tu volumen, y el que cambian los índices de tus vistas.

## Lo que cambió 0.3.0

Las claves de idempotencia y los snapshots llegaron los dos en Bounda 0.3.0, y lo primero ya está
arriba: tres filas por un comando que se puede reintentar sin miedo.

Los snapshots son lo interesante, porque en un Durable Object no hacen lo que cabría esperar. Añadí
un comando `addLine` a la misma aplicación y mandé 400 a un mismo pedido, primero sin snapshots y
después con un snapshot cada 100 eventos.

| Stream de 400 eventos | Filas escritas por comando | Filas leídas por comando |
|---|---|---|
| Sin snapshots | 6 | 429, una más por cada evento |
| Con un snapshot cada 100 eventos | 7 | unas 44, más hasta 100 desde el último snapshot |

Sin snapshot, el comando lee el stream entero, así que sus lecturas crecen con cada evento. Con
uno, lee el snapshot y los eventos posteriores. La fila de más es el checkpoint del suscriptor de
snapshots, que sigue al stream global como lo hace un read model; los snapshots en sí añaden una
fila cada cien eventos. En los 400 comandos, los snapshots ahorraron unas 53.000 filas leídas y
costaron unas 400 filas escritas más.

A los precios de Cloudflare, 53.000 filas leídas cuestan cinco milésimas de céntimo, y 400 filas
escritas, cuatro centésimas. **En un Durable Object, un snapshot es una decisión de latencia, no de
factura**: compra un comando que pliega 44 filas en vez de 429, y cuesta un poco más. Para la
mayoría de agregados, lo mejor es un stream más corto: cerrar el periodo y abrir el siguiente
([long streams](https://docs.bounda.dev/concepts/long-streams/), en inglés).

La fila de `addLine` enseña una cosa más: ningún read model proyecta su evento, así que el comando
responde sin tocar ninguno, y la alarma que sigue mueve el checkpoint del read model más allá de
él. Esa es la sexta fila y la segunda petición.

## Lo que promete, y lo que no

- **Los read models se actualizan exactamente una vez por lote.** Las filas y el checkpoint se
  confirman en una transacción, así que un fallo a mitad no deja ni lo uno ni lo otro.
- **Las policies y los processes corren al menos una vez, con una bandeja de entrada.** Un intento
  escribe todo lo que decidió en una transacción o nada, y llama hacia fuera con un
  `idempotencyKey`.
- **Un objeto es un escritor.** Se escala añadiendo tenants, no partiendo el stream de uno.

Los detalles están en [delivery guarantees](https://docs.bounda.dev/concepts/delivery-guarantees/),
[how it runs](https://docs.bounda.dev/concepts/how-it-runs/) y el
[adaptador de Cloudflare](https://docs.bounda.dev/adapters/cloudflare/), en inglés.

## Cuándo es el diseño equivocado

Un objeto por tenant es una buena opción por defecto para un SaaS en el que los tenants son
independientes. Encaja mal cuando el trabajo no se reparte así.

- **Un tenant escribe demasiado.** Un objeto corre en un hilo y confirma un comando cada vez, y
  Cloudflare pone el límite blando en unas 1.000 peticiones por segundo por objeto. Un libro de
  órdenes compartido, un contador global, un tenant enorme que eclipsa al resto: todos sus comandos
  hacen cola uno detrás de otro.
- **Los usuarios están lejos del objeto.** Un objeto vive en una región, y un usuario en otro
  continente paga el viaje de ida y vuelta en cada comando.
- **Un tenant guarda mucha historia.** El SQLite de un objeto admite 10 GB. A 600 bytes por comando
  son unos dieciséis millones de comandos, en total, porque el event store solo crece. Un tenant que
  vaya a superarlo necesita su historia partida por algo que el dominio ya conozca, como un año o
  una región.
- **Consultas que cruzan tenants.** Cada objeto tiene sus propios read models. Un informe sobre
  todos los tenants necesita copiar los eventos a otro sitio, y esa tubería la construyes tú.
- **El volumen es constante y alto.** A 8,50 $ el millón, varios millones de comandos al día todos
  los días suman, y una base de datos en una máquina alquilada por meses puede salir más barata. El
  Durable Object gana cuando la carga se reparte entre muchos tenants y muchos están inactivos.

Si lo que necesitas es el estado actual de un objeto y no su historia, el `setState()` del
[Agents SDK](https://developers.cloudflare.com/agents/) lo guarda con menos maquinaria. El event
sourcing se gana sus filas cuando las preguntas son sobre el pasado: por qué se canceló un pedido,
qué mostraba un panel el mes pasado, qué puede aprender una funcionalidad nueva de datos que ya
tienes.

## Cuéntalas tú

Las cifras de arriba salen de un test en workerd, con la integración de Vitest de Cloudflare, que es
como el proyecto generado ya ejecuta sus tests. Crea un proyecto y añade un fichero:

```bash
npm create bounda@0.3.0 cost -- --runtime cloudflare
```

```ts
// tests/cost.test.ts
import { connect } from "@bounda-dev/cloudflare";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];

it("counts the rows a command writes", async () => {
  const stub = env.STORE.get(env.STORE.idFromName("cost"));
  const store = connect(stub);
  // The first command creates the schema; measure the ones after it.
  await store.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "ada", total: 1 });

  await runInDurableObject(stub, (_object, state) => {
    const sql = Object.getPrototypeOf(state.storage.sql);
    const exec = sql.exec;
    sql.exec = function (this: SqlStorage, ...args: Parameters<SqlStorage["exec"]>) {
      const cursor = exec.apply(this, args);
      cursors.push(cursor);
      return cursor;
    };
  });

  await store.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "ada", total: 42 });
  const written = cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
  expect(written).toBe(8);
});
```

`npm test` lo ejecuta. Cada sentencia que corre el objeto pasa por `exec`, y cada cursor cuenta sus
propias filas. Cambia el comando, añade una policy o un índice, y el recuento lo sigue. En
producción, las métricas de Durable Objects del panel de Cloudflare enseñan las filas leídas y
escritas por cada namespace.

Todas las cifras se midieron el 7 de noviembre de 2026 con Bounda 0.3.0, wrangler 4.158 y
`@cloudflare/vitest-plugin` 1.6. Una versión posterior puede escribir otro número de filas; el test
es la forma de saberlo.

## Pruébalo

La [demo](https://demo.bounda.dev) es la taquilla de un teatro con un Durable Object por visitante.
Abre la escena **Rush hour**: seis compradores llegan a la vez, y cuando reservas un asiento te
enseña cuánto del espectáculo plegó tu comando desde un snapshot. Para desplegar el tuyo, usa el
botón [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)
o `npm create bounda@latest my-app -- --runtime cloudflare`.
